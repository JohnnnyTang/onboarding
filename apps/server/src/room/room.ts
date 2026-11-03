import type { RulesHostClient } from "@bgp/rules-host";
import {
  type ClientView,
  type EphemeralData,
  type ErrorCode,
  type GameResult,
  type MoveIntent,
  PROTOCOL_VERSION,
  type SeatId,
  type SeatInfo,
  type ServerMessage,
} from "@bgp/schema";
import type { Database } from "../db/connection.js";
import {
  type AppendResult,
  appendEvent,
  eventsAfter,
  insertSnapshot,
  latestSnapshot,
  loadMatch,
  type StoredMatch,
  type StoredSnapshot,
} from "./store.js";
import { viewStrings, viewUpdate } from "./view-diff.js";

/** The rules host operations the room server needs; `RulesHostClient` provides them. */
export type RoomEngine = Pick<
  RulesHostClient,
  "load" | "create" | "apply" | "views" | "hash" | "exportState" | "restore" | "dispose"
>;

/** One connection after a successful `hello`, as the room sees it. */
export interface RoomClient {
  readonly seat: SeatId;
  readonly name: string;
  send(message: ServerMessage): void;
  /** Send a fatal `error`, then close the connection. */
  fail(code: ErrorCode, message: string): void;
  /** Close without an error (server shutdown); the client reconnects. */
  disconnect(): void;
}

export interface RoomLogger {
  error(details: object, message: string): void;
}

export interface RoomDependencies {
  db: Database;
  engine: RoomEngine;
  log: RoomLogger;
  /** Dispose an empty room (and its rules host match) after this many milliseconds. */
  idleMs: number;
}

interface Member {
  client: RoomClient;
  /** The last view sent to this connection; patches are computed against it. */
  view: ClientView;
  known: Set<string> | undefined;
}

export type JoinResult = "joined" | "failed" | "closed";

/** A snapshot is stored after setup (seq 0), every this many events, and at the end. */
export const SNAPSHOT_INTERVAL = 50;
const GAME_ERROR_MESSAGE = "Game execution failed";
const INTERNAL_MESSAGE = "Internal server error";

/**
 * One live match. Every operation that reads or changes match state runs on a single
 * serial queue, so moves apply strictly one at a time in arrival order. An accepted
 * event is stored in PostgreSQL before any connection hears about it.
 */
export class Room {
  private queue: Promise<void> = Promise.resolve();
  private readonly members = new Map<RoomClient, Member>();
  private match: StoredMatch | null = null;
  private views: Record<SeatId, ClientView> = {};
  private seq = 0;
  private result: GameResult | null = null;
  private ready = false;
  private closed = false;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly matchId: string,
    private readonly deps: RoomDependencies,
    private readonly onClosed: (room: Room) => void,
  ) {}

  /** Seat presence for the HTTP match summaries. */
  isConnected(seat: SeatId): boolean {
    for (const member of this.members.values()) if (member.client.seat === seat) return true;
    return false;
  }

  join(client: RoomClient): Promise<JoinResult> {
    return this.run(async () => {
      if (this.closed) return "closed";
      this.cancelIdle();
      if (!(await this.ensureReady())) {
        client.fail("INTERNAL", INTERNAL_MESSAGE);
        this.scheduleIdle();
        return "failed";
      }
      if (this.result !== null) {
        client.fail("MATCH_NOT_ACTIVE", "The match has finished");
        this.scheduleIdle();
        return "failed";
      }
      for (const member of this.members.values()) {
        if (member.client.seat !== client.seat) continue;
        this.members.delete(member.client);
        member.client.fail("SEAT_TAKEN_OVER", "Another connection took this seat");
      }
      const view = this.viewOf(client.seat);
      this.members.set(client, { client, view, known: undefined });
      client.send({
        t: "welcome",
        protocol: PROTOCOL_VERSION,
        seat: client.seat,
        match: this.summary(),
        seq: this.seq,
        view,
      });
      this.broadcastPresence();
      return "joined";
    });
  }

  /** A closed connection; safe to call more than once. */
  leave(client: RoomClient): void {
    if (!this.members.delete(client)) return;
    this.broadcastPresence();
    this.scheduleIdle();
  }

  move(client: RoomClient, clientSeq: number, intent: MoveIntent): Promise<void> {
    return this.run(async () => {
      const member = this.members.get(client);
      if (!member || this.closed) return;
      await this.applyMove(member, clientSeq, intent);
    });
  }

  resync(client: RoomClient): Promise<void> {
    return this.run(async () => {
      const member = this.members.get(client);
      if (!member || this.closed) return;
      this.sendSnapshot(member);
    });
  }

  chat(client: RoomClient, text: string): void {
    if (!this.members.has(client)) return;
    const at = new Date().toISOString();
    for (const member of this.members.values()) {
      member.client.send({ t: "chat", from: client.seat, name: client.name, text, at });
    }
  }

  /**
   * Relays pointer and drag positions to the other seats. A dragged item ID is relayed only
   * to seats whose current view already contains it; others receive a plain pointer, so a
   * drag of a hidden card never tells another seat which card it is.
   */
  relay(client: RoomClient, data: EphemeralData): void {
    if (!this.members.has(client)) return;
    for (const member of this.members.values()) {
      if (member.client === client) continue;
      member.known ??= viewStrings(member.view);
      const visible =
        data.kind === "pointer" || member.known.has(data.item)
          ? data
          : { kind: "pointer" as const, pos_mm: data.pos_mm };
      member.client.send({ t: "ephemeral", from: client.seat, data: visible });
    }
  }

  /** The rules host process of this match died; rebuild from storage and resend views. */
  hostExited(): Promise<void> {
    return this.run(async () => {
      if (this.closed || !this.ready) return;
      if (this.members.size === 0) {
        this.ready = false;
        return;
      }
      await this.recover(true);
    });
  }

  /** The match left `active` through the HTTP API (abandon). */
  abandoned(): Promise<void> {
    return this.run(async () => {
      this.shutdown("MATCH_NOT_ACTIVE", "The match is no longer active");
    });
  }

  /** Server shutdown: close every connection and release the rules host match. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelIdle();
    for (const member of this.members.values()) member.client.disconnect();
    this.members.clear();
    this.deps.engine.dispose(this.matchId);
  }

  private async applyMove(member: Member, clientSeq: number, intent: MoveIntent): Promise<void> {
    const { client } = member;
    if (this.result !== null) {
      return this.reject(client, clientSeq, "MATCH_FINISHED", "The match has finished");
    }
    const { engine } = this.deps;
    let outcome: Awaited<ReturnType<RoomEngine["apply"]>>;
    try {
      outcome = await engine.apply(this.matchId, client.seat, intent);
    } catch {
      // The host failed before acknowledging; the uncertain move is discarded, never retried.
      return this.reject(client, clientSeq, "GAME_ERROR", GAME_ERROR_MESSAGE);
    }
    if (!outcome.ok) {
      return this.reject(
        client,
        clientSeq,
        outcome.code,
        outcome.code === "GAME_ERROR" ? GAME_ERROR_MESSAGE : outcome.message,
        outcome.gameCode,
      );
    }
    const { event } = outcome;
    let views: Record<SeatId, ClientView>;
    let snapshot: StoredSnapshot | null = null;
    let result: GameResult | null = null;
    try {
      if (event.seq !== this.seq + 1) throw new Error("Out-of-order event from the rules host");
      views = await engine.views(this.matchId);
      const ended = Object.values(views).some((view) => view.result !== null);
      if (ended || event.seq % SNAPSHOT_INTERVAL === 0) {
        const state = await engine.exportState(this.matchId);
        snapshot = { seq: event.seq, state, stateHash: await engine.hash(this.matchId) };
        result = state.result;
      }
    } catch (error) {
      // The host holds an event that was never stored: rebuild it from the stored log.
      this.deps.log.error({ err: error, matchId: this.matchId }, "room move failed in host");
      this.reject(client, clientSeq, "GAME_ERROR", GAME_ERROR_MESSAGE);
      return this.recover(false);
    }
    let stored: AppendResult | "error";
    try {
      stored = await appendEvent(this.deps.db, this.matchId, event, snapshot, result);
    } catch (error) {
      this.deps.log.error({ err: error, matchId: this.matchId }, "room event not stored");
      stored = "error";
    }
    if (stored === "inactive") {
      this.reject(client, clientSeq, "MATCH_NOT_ACTIVE", "The match is no longer active");
      return this.shutdown("MATCH_NOT_ACTIVE", "The match is no longer active");
    }
    if (stored !== "ok") {
      this.reject(client, clientSeq, "INTERNAL", INTERNAL_MESSAGE);
      return this.recover(false);
    }
    // Stored: now, and only now, every connection hears about the event.
    this.seq = event.seq;
    this.views = views;
    for (const other of this.members.values()) {
      const next = this.viewOf(other.client.seat);
      const update = viewUpdate(other.view, next);
      other.view = next;
      other.known = undefined;
      if (update.kind === "snapshot") {
        other.client.send({ t: "snapshot", seq: this.seq, view: next });
        continue;
      }
      other.client.send({
        t: "patch",
        seq: this.seq,
        ops: update.ops,
        cause: {
          seat: client.seat,
          ...(other === member ? { clientSeq } : {}),
          move: event.intent.move,
        },
      });
    }
    if (result !== null) {
      this.result = result;
      if (this.match) this.match.status = "finished";
      for (const other of this.members.values()) other.client.send({ t: "ended", result });
    }
  }

  private reject(
    client: RoomClient,
    clientSeq: number,
    code: ErrorCode,
    message: string,
    gameCode?: string,
  ): void {
    client.send({
      t: "rejected",
      clientSeq,
      code,
      message,
      ...(gameCode === undefined ? {} : { gameCode }),
    });
  }

  private sendSnapshot(member: Member): void {
    member.view = this.viewOf(member.client.seat);
    member.known = undefined;
    member.client.send({ t: "snapshot", seq: this.seq, view: member.view });
  }

  private async ensureReady(): Promise<boolean> {
    if (this.ready) return true;
    try {
      await this.rebuild();
      return true;
    } catch (error) {
      this.deps.log.error({ err: error, matchId: this.matchId }, "room could not load match");
      return false;
    }
  }

  /** Rebuild the host match from storage; on failure every connection is closed. */
  private async recover(sendSnapshots: boolean): Promise<void> {
    this.ready = false;
    if (!(await this.ensureReady())) {
      for (const member of this.members.values()) member.client.fail("INTERNAL", INTERNAL_MESSAGE);
      this.members.clear();
      this.scheduleIdle();
      return;
    }
    if (sendSnapshots) for (const member of this.members.values()) this.sendSnapshot(member);
  }

  /**
   * Loads the latest stored snapshot (writing the seq 0 snapshot on first activation),
   * replays the later stored events in a fresh rules host match and checks the hash
   * where a snapshot of the current sequence exists.
   */
  private async rebuild(): Promise<void> {
    const { db, engine } = this.deps;
    const match = await loadMatch(db, this.matchId);
    if (!match) throw new Error("Match disappeared");
    engine.dispose(this.matchId);
    await engine.load(match.buildHash);
    await engine.create(this.matchId, {
      buildHash: match.buildHash,
      seats: match.seats.map((seat) => seat.seat),
      seed: match.seed,
      options: match.options,
    });
    let snapshot = await latestSnapshot(db, this.matchId);
    if (!snapshot) {
      const state = await engine.exportState(this.matchId);
      snapshot = { seq: 0, state, stateHash: await engine.hash(this.matchId) };
      await insertSnapshot(db, this.matchId, snapshot);
    }
    const events = await eventsAfter(db, this.matchId, snapshot.seq);
    const contiguous = events.every((event, index) => event.seq === snapshot.seq + index + 1);
    if (!contiguous || snapshot.seq + events.length !== match.lastSeq) {
      throw new Error("Stored match log is not contiguous");
    }
    await engine.restore(this.matchId, snapshot.state, events);
    if (events.length === 0 && (await engine.hash(this.matchId)) !== snapshot.stateHash) {
      throw new Error("Stored snapshot hash mismatch");
    }
    const views = await engine.views(this.matchId);
    this.match = match;
    this.views = views;
    this.seq = match.lastSeq;
    this.result = Object.values(views).find((view) => view.result !== null)?.result ?? null;
    this.ready = true;
  }

  private viewOf(seat: SeatId): ClientView {
    const view = this.views[seat];
    if (!view) throw new Error("No view for a seated connection");
    return view;
  }

  private seatInfos(): SeatInfo[] {
    return (this.match?.seats ?? []).map((seat) => ({
      seat: seat.seat,
      name: seat.name,
      connected: this.isConnected(seat.seat),
      guest: seat.guest,
    }));
  }

  private summary() {
    const match = this.match;
    if (!match) throw new Error("Room without a match");
    return {
      id: match.id,
      status: this.result === null ? match.status : ("finished" as const),
      versionId: match.versionId,
      buildHash: match.buildHash,
      seats: this.seatInfos(),
    };
  }

  private broadcastPresence(): void {
    const seats = this.seatInfos();
    for (const member of this.members.values()) member.client.send({ t: "presence", seats });
  }

  private shutdown(code: ErrorCode, message: string): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelIdle();
    for (const member of this.members.values()) member.client.fail(code, message);
    this.members.clear();
    this.deps.engine.dispose(this.matchId);
    this.onClosed(this);
  }

  private scheduleIdle(): void {
    if (this.closed || this.members.size > 0) return;
    this.cancelIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.run(async () => {
        if (this.closed || this.members.size > 0) return;
        this.closed = true;
        this.deps.engine.dispose(this.matchId);
        this.onClosed(this);
      });
    }, this.deps.idleMs);
    this.idleTimer.unref();
  }

  private cancelIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.then(
      () => undefined,
      (error: unknown) => {
        this.deps.log.error({ err: error, matchId: this.matchId }, "room task failed");
      },
    );
    return result;
  }
}
