import {
  type AcceptedEvent,
  AcceptedEventSchema,
  type ClientView,
  type HostCommand,
  HostMatchIdSchema,
  type HostMatchInit,
  HostMatchInitSchema,
  HostMoveOutcomeSchema,
  HostViewsSchema,
  type MatchState,
  MatchStateSchema,
  type MoveIntent,
  MoveIntentSchema,
  type SeatId,
  SeatIdSchema,
  Sha256Schema,
} from "@bgp/schema";
import { type BuildStore, loadBuild } from "./build-store.js";
import { GameError } from "./errors.js";
import { HostPool } from "./host-pool.js";
import type { HostProcess } from "./host-process.js";
import type { MoveOutcome, SandboxOptions } from "./sandbox.js";

interface HostedMatch {
  source: string;
  snapshot?: MatchState;
  events: AcceptedEvent[];
  host?: HostProcess;
  queue: Promise<void>;
  disposed: boolean;
  idleVersion: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export interface RulesHostClientOptions extends SandboxOptions {
  /** Checkpoint and retire a process after this many idle milliseconds; 0 disables. */
  idleTimeoutMs?: number;
  /** Unassigned prewarmed processes only; never reuse a process that ran a game. */
  warmSpareCount?: number;
}

/** Server-only client. Checkpoints and journals contain privileged match data. */
export class RulesHostClient {
  private readonly builds = new Map<string, string>();
  private readonly matches = new Map<string, HostedMatch>();
  private readonly options: Required<SandboxOptions>;
  private readonly idleTimeoutMs: number;
  private readonly pool: HostPool;
  private closed = false;

  constructor(
    private readonly store: BuildStore,
    options: RulesHostClientOptions = {},
  ) {
    const timeoutMs = options.timeoutMs ?? 1000;
    const memoryLimitBytes = options.memoryLimitBytes ?? 64 * 1024 * 1024;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 1000 ||
      !Number.isSafeInteger(memoryLimitBytes) ||
      memoryLimitBytes < 1 ||
      memoryLimitBytes > 64 * 1024 * 1024
    )
      throw new GameError();
    this.options = { timeoutMs, memoryLimitBytes };
    this.idleTimeoutMs = options.idleTimeoutMs ?? 10_000;
    const warmSpareCount = options.warmSpareCount ?? 1;
    if (
      !Number.isInteger(this.idleTimeoutMs) ||
      this.idleTimeoutMs < 0 ||
      this.idleTimeoutMs > 3_600_000 ||
      !Number.isInteger(warmSpareCount) ||
      warmSpareCount < 0 ||
      warmSpareCount > 2
    )
      throw new GameError();
    this.pool = new HostPool(this.options, warmSpareCount);
  }

  async load(buildHash: string): Promise<void> {
    try {
      if (this.closed) throw new GameError();
      Sha256Schema.parse(buildHash);
      if (this.builds.has(buildHash)) return;
      const source = await loadBuild(this.store, buildHash);
      if (this.closed) throw new GameError();
      this.builds.set(buildHash, source);
    } catch {
      throw new GameError();
    }
  }

  async create(matchId: string, input: HostMatchInit): Promise<void> {
    try {
      HostMatchIdSchema.parse(matchId);
      const init = structuredClone(HostMatchInitSchema.parse(input));
      const source = this.builds.get(init.buildHash);
      if (this.closed || this.matches.has(matchId) || source === undefined) throw new GameError();
      const record: HostedMatch = {
        source,
        events: [],
        queue: Promise.resolve(),
        disposed: false,
        idleVersion: 0,
      };
      this.matches.set(matchId, record);
      try {
        await this.enqueue(record, async (deadline) => {
          const host = await this.spawn(record);
          await this.send(host, { op: "load", source, ...this.options }, deadline);
          const { buildHash: _buildHash, ...matchInit } = init;
          await this.send(host, { op: "create", init: matchInit }, deadline);
          await this.checkpoint(record, host, deadline);
        });
      } catch {
        record.disposed = true;
        record.host?.dispose();
        if (this.matches.get(matchId) === record) this.matches.delete(matchId);
        throw new GameError();
      }
    } catch {
      throw new GameError();
    }
  }

  async apply(matchId: string, seat: SeatId, intent: MoveIntent): Promise<MoveOutcome> {
    try {
      const actor = SeatIdSchema.parse(seat);
      const move = structuredClone(MoveIntentSchema.parse(intent));
      const record = this.record(matchId);
      return await this.enqueue(record, async (deadline) => {
        const host = await this.ready(record, deadline);
        const outcome = HostMoveOutcomeSchema.parse(
          await this.send(host, { op: "apply", seat: actor, intent: move }, deadline),
        );
        if (outcome.ok) {
          const previous = record.events.at(-1)?.seq ?? record.snapshot?.ctx.moveNumber;
          if (
            previous === undefined ||
            outcome.event.seq !== previous + 1 ||
            outcome.event.seat !== actor ||
            outcome.event.intent.move !== move.move
          )
            throw new GameError();
          record.events.push(structuredClone(outcome.event));
        } else if (outcome.code === "GAME_ERROR") host.dispose();
        return outcome.ok
          ? outcome
          : {
              ok: false,
              code: outcome.code,
              message: outcome.message,
              ...(outcome.gameCode === undefined ? {} : { gameCode: outcome.gameCode }),
            };
      });
    } catch {
      throw new GameError();
    }
  }

  async views(matchId: string): Promise<Record<SeatId, ClientView>> {
    const record = this.record(matchId);
    return this.enqueue(record, async (deadline) => {
      const host = await this.ready(record, deadline);
      const views = HostViewsSchema.parse(await this.send(host, { op: "views" }, deadline));
      const seats = record.snapshot?.ctx.seats;
      if (
        !seats ||
        Object.keys(views).length !== seats.length ||
        !seats.every((seat) => Object.hasOwn(views, seat))
      )
        throw new GameError();
      return views;
    });
  }

  async hash(matchId: string): Promise<string> {
    const record = this.record(matchId);
    return this.enqueue(record, async (deadline) =>
      Sha256Schema.parse(
        await this.send(await this.ready(record, deadline), { op: "hash" }, deadline),
      ),
    );
  }

  async exportState(matchId: string): Promise<MatchState> {
    const record = this.record(matchId);
    return this.enqueue(record, async (deadline) =>
      this.checkpoint(record, await this.ready(record, deadline), deadline),
    );
  }

  async restore(matchId: string, snapshot: MatchState, events: AcceptedEvent[]): Promise<void> {
    try {
      const checkpoint = structuredClone(MatchStateSchema.parse(snapshot));
      const journal = structuredClone(events.map((event) => AcceptedEventSchema.parse(event)));
      const record = this.record(matchId);
      await this.enqueue(record, async (deadline) => {
        if (JSON.stringify(checkpoint.ctx.seats) !== JSON.stringify(record.snapshot?.ctx.seats))
          throw new GameError();
        const host = await this.loaded(record, deadline);
        await this.send(host, { op: "restore", snapshot: checkpoint, events: journal }, deadline);
        record.snapshot = checkpoint;
        record.events = journal;
      });
    } catch {
      throw new GameError();
    }
  }

  /** Privileged diagnostics for supervision; never include this in browser payloads. */
  processId(matchId: string): number | undefined {
    const host = this.record(matchId).host;
    return host?.alive ? host.pid : undefined;
  }

  /** Unassigned trusted processes only; privileged supervision, never player data. */
  spareProcessIds(): number[] {
    return this.pool.processIds();
  }

  dispose(matchId: string): void {
    const record = this.matches.get(matchId);
    if (!record) return;
    record.disposed = true;
    this.cancelIdle(record);
    record.host?.dispose();
    this.matches.delete(matchId);
  }

  close(): void {
    this.closed = true;
    this.pool.close();
    for (const matchId of this.matches.keys()) this.dispose(matchId);
    this.builds.clear();
  }

  private record(matchId: string): HostedMatch {
    const record = this.matches.get(matchId);
    if (this.closed || !record || record.disposed) throw new GameError();
    return record;
  }

  private async spawn(record: HostedMatch): Promise<HostProcess> {
    if (record.disposed || this.closed) throw new GameError();
    const host = await this.pool.take();
    if (record.disposed || this.closed) {
      host.dispose();
      throw new GameError();
    }
    record.host = host;
    return host;
  }

  private async ready(record: HostedMatch, deadline: number): Promise<HostProcess> {
    if (record.host?.alive) return record.host;
    const host = await this.loaded(record, deadline);
    if (!record.snapshot) throw new GameError();
    await this.send(
      host,
      { op: "restore", snapshot: record.snapshot, events: record.events },
      deadline,
    );
    return host;
  }

  private async loaded(record: HostedMatch, deadline: number): Promise<HostProcess> {
    if (record.host?.alive) return record.host;
    const host = await this.spawn(record);
    await this.send(host, { op: "load", source: record.source, ...this.options }, deadline);
    return host;
  }

  private async send(host: HostProcess, command: HostCommand, deadline: number): Promise<unknown> {
    return host.call(command, Math.floor(deadline - performance.now()));
  }

  private async checkpoint(
    record: HostedMatch,
    host: HostProcess,
    deadline: number,
  ): Promise<MatchState> {
    const snapshot = MatchStateSchema.parse(await this.send(host, { op: "exportState" }, deadline));
    const seq = record.events.at(-1)?.seq ?? record.snapshot?.ctx.moveNumber ?? 0;
    if (snapshot.ctx.moveNumber !== seq) throw new GameError();
    record.snapshot = structuredClone(snapshot);
    record.events = [];
    return snapshot;
  }

  private cancelIdle(record: HostedMatch): void {
    record.idleVersion++;
    clearTimeout(record.idleTimer);
    delete record.idleTimer;
  }

  private armIdle(record: HostedMatch): void {
    this.cancelIdle(record);
    if (record.disposed || this.closed || this.idleTimeoutMs === 0 || !record.host?.alive) return;
    const version = record.idleVersion;
    record.idleTimer = setTimeout(() => {
      delete record.idleTimer;
      void this.queue(record, async (deadline) => {
        if (record.idleVersion !== version || !record.host?.alive) return;
        const host = record.host;
        await this.checkpoint(record, host, deadline);
        host.dispose();
        delete record.host;
      }).catch(() => {});
    }, this.idleTimeoutMs);
    record.idleTimer.unref();
  }

  private enqueue<T>(record: HostedMatch, run: (deadline: number) => Promise<T>): Promise<T> {
    this.cancelIdle(record);
    return this.queue(record, run).finally(() => this.armIdle(record));
  }

  private queue<T>(record: HostedMatch, run: (deadline: number) => Promise<T>): Promise<T> {
    const result = record.queue.then(async () => {
      if (record.disposed || this.closed) throw new GameError();
      // Bound complete recovery/load/setup sequences as well as individual IPCs.
      const deadline = performance.now() + this.options.timeoutMs;
      try {
        return await run(deadline);
      } catch {
        record.host?.dispose();
        throw new GameError();
      }
    });
    record.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
