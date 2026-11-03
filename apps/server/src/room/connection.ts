import {
  type ClientMessage,
  ClientMessageSchema,
  type ErrorCode,
  type HelloMessage,
  PROTOCOL_VERSION,
  type SeatId,
  type ServerMessage,
  ServerMessageSchema,
} from "@bgp/schema";
import { AuthError, type AuthService, type CallerIdentity } from "../auth/service.js";
import type { Database } from "../db/connection.js";
import type { RoomManager } from "./manager.js";
import { type LimitedMessage, RATE_LIMITS, RateLimiter } from "./rate-limit.js";
import type { Room, RoomClient, RoomLogger } from "./room.js";
import { loadMatch } from "./store.js";

/** The parts of a WebSocket a connection uses; text frames only. */
export interface Transport {
  isOpen(): boolean;
  send(text: string): void;
  close(code: number, reason: string): void;
}

export interface ConnectionOptions {
  db: Database;
  auth: AuthService;
  rooms: RoomManager;
  log: RoomLogger;
  /** The first message must be `hello` within this time (protocol: 10 seconds). */
  helloTimeoutMs: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLOSE_POLICY = 1008;
const CLOSE_INTERNAL = 1011;
const CLOSE_GOING_AWAY = 1001;

type Phase = "hello" | "joining" | "joined" | "closed";

class HandshakeError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * One WebSocket connection: the `hello` handshake, message validation, rate limits and
 * dispatch to the match room. Messages are handled in arrival order; anything sent
 * while the handshake is running waits for it.
 */
export class ClientConnection implements RoomClient {
  private phase: Phase = "hello";
  private room: Room | null = null;
  private seatId: SeatId | null = null;
  private seatName = "";
  private lastClientSeq = -1;
  private pending: Promise<void> = Promise.resolve();
  private readonly helloTimer: ReturnType<typeof setTimeout>;
  private readonly limits: Record<LimitedMessage, RateLimiter> = {
    move: new RateLimiter(RATE_LIMITS.move),
    ephemeral: new RateLimiter(RATE_LIMITS.ephemeral),
    chat: new RateLimiter(RATE_LIMITS.chat),
  };

  constructor(
    private readonly transport: Transport,
    private readonly options: ConnectionOptions,
  ) {
    this.helloTimer = setTimeout(
      () => this.fail("BAD_MESSAGE", "Expected hello"),
      options.helloTimeoutMs,
    );
    this.helloTimer.unref();
  }

  get seat(): SeatId {
    if (this.seatId === null) throw new Error("Connection has no seat yet");
    return this.seatId;
  }

  get name(): string {
    return this.seatName;
  }

  /** A text frame's content, or `null` for a binary frame. */
  receive(text: string | null): void {
    if (this.phase === "closed") return;
    const message = this.parse(text);
    if (message === null) return;
    if (this.phase === "hello") {
      if (message.t !== "hello") {
        this.fail("BAD_MESSAGE", "Expected hello");
        return;
      }
      clearTimeout(this.helloTimer);
      this.phase = "joining";
      this.after(() => this.handshake(message));
      return;
    }
    if (message.t === "hello") {
      this.error("BAD_MESSAGE", "Already joined");
      return;
    }
    if (
      (message.t === "move" || message.t === "ephemeral" || message.t === "chat") &&
      !this.limits[message.t].allow()
    ) {
      this.error("RATE_LIMITED", "Too many messages");
      return;
    }
    this.after(async () => this.dispatch(message));
  }

  /** The socket closed, for any reason. */
  closed(): void {
    if (this.phase === "closed") return;
    this.phase = "closed";
    clearTimeout(this.helloTimer);
    this.room?.leave(this);
  }

  send(message: ServerMessage): void {
    if (this.phase === "closed" || !this.transport.isOpen()) return;
    // Every outgoing frame must match the contract exactly; anything else is a server bug.
    const checked = ServerMessageSchema.safeParse(message);
    if (!checked.success) {
      this.options.log.error({ type: message.t }, "room message failed the protocol schema");
      this.fail("INTERNAL", "Internal server error");
      return;
    }
    this.transport.send(JSON.stringify(checked.data));
  }

  fail(code: ErrorCode, message: string): void {
    if (this.phase === "closed") return;
    this.send({ t: "error", code, message, fatal: true });
    this.closed();
    this.transport.close(code === "INTERNAL" ? CLOSE_INTERNAL : CLOSE_POLICY, code);
  }

  disconnect(): void {
    if (this.phase === "closed") return;
    this.closed();
    this.transport.close(CLOSE_GOING_AWAY, "Server stopping");
  }

  /** Read through a method: the phase changes while the handshake awaits. */
  private isClosed(): boolean {
    return this.phase === "closed";
  }

  private error(code: ErrorCode, message: string): void {
    this.send({ t: "error", code, message, fatal: false });
  }

  private parse(text: string | null): ClientMessage | null {
    let raw: unknown;
    try {
      if (text === null) throw new Error("Binary frame");
      raw = JSON.parse(text);
    } catch {
      this.reportBadMessage("Messages must be JSON text frames");
      return null;
    }
    if (
      typeof raw === "object" &&
      raw !== null &&
      "t" in raw &&
      raw.t === "hello" &&
      (!("protocol" in raw) || raw.protocol !== PROTOCOL_VERSION)
    ) {
      this.fail("PROTOCOL_VERSION", `Protocol ${PROTOCOL_VERSION} is required`);
      return null;
    }
    const parsed = ClientMessageSchema.safeParse(raw);
    if (!parsed.success) {
      // Never echo the submitted values back.
      this.reportBadMessage("Message failed schema validation");
      return null;
    }
    return parsed.data;
  }

  /** Before `hello` every problem is fatal; afterwards only the message is dropped. */
  private reportBadMessage(message: string): void {
    if (this.phase === "hello") this.fail("BAD_MESSAGE", message);
    else this.error("BAD_MESSAGE", message);
  }

  private after(task: () => Promise<void>): void {
    this.pending = this.pending.then(async () => {
      if (this.phase === "closed") return;
      try {
        await task();
      } catch (error) {
        this.options.log.error({ err: error }, "room connection task failed");
        this.fail("INTERNAL", "Internal server error");
      }
    });
  }

  private async dispatch(message: Exclude<ClientMessage, HelloMessage>): Promise<void> {
    const room = this.room;
    if (this.phase !== "joined" || room === null) return;
    switch (message.t) {
      case "move":
        if (message.clientSeq <= this.lastClientSeq) {
          this.send({
            t: "rejected",
            clientSeq: message.clientSeq,
            code: "BAD_MESSAGE",
            message: "clientSeq must increase",
          });
          return;
        }
        this.lastClientSeq = message.clientSeq;
        // Queued in the room in arrival order; the room answers on its own.
        void room.move(this, message.clientSeq, message.intent).catch(() => {});
        return;
      case "resync":
        void room.resync(this).catch(() => {});
        return;
      case "ephemeral":
        room.relay(this, message.data);
        return;
      case "chat":
        room.chat(this, message.text);
        return;
      case "ping":
        this.send({ t: "pong", ts: message.ts });
        return;
    }
  }

  private async handshake(hello: HelloMessage): Promise<void> {
    try {
      const identity = await this.authenticate(hello);
      const seat = await this.seatFor(identity, hello.matchId);
      this.seatId = seat.seat;
      this.seatName = seat.name;
    } catch (error) {
      if (!(error instanceof HandshakeError)) throw error;
      return this.fail(error.code, error.message);
    }
    if (this.isClosed()) return;
    const room = await this.options.rooms.join(hello.matchId, this);
    if (room === null || this.isClosed()) {
      room?.leave(this);
      return;
    }
    this.room = room;
    this.phase = "joined";
  }

  private async authenticate(hello: HelloMessage): Promise<CallerIdentity> {
    let identity: CallerIdentity;
    try {
      identity = await this.options.auth.authenticate(`Bearer ${hello.auth.token}`);
    } catch (error) {
      if (error instanceof AuthError) {
        throw new HandshakeError("UNAUTHORIZED", "Missing or invalid credentials");
      }
      throw error;
    }
    if (identity.kind !== hello.auth.kind) {
      throw new HandshakeError("UNAUTHORIZED", "Missing or invalid credentials");
    }
    if (identity.kind === "guest" && identity.matchId !== hello.matchId) {
      throw new HandshakeError("FORBIDDEN", "Access denied");
    }
    return identity;
  }

  /** Seat holders only: an owner without a seat has no view to receive (Q-016). */
  private async seatFor(identity: CallerIdentity, matchId: string) {
    const match = UUID.test(matchId) ? await loadMatch(this.options.db, matchId) : null;
    if (!match) throw new HandshakeError("MATCH_NOT_FOUND", "Match not found");
    const seat = match.seats.find((candidate) =>
      identity.kind === "user"
        ? candidate.userId === identity.user.id
        : candidate.guest && candidate.seat === identity.seat,
    );
    if (!seat?.claimed) throw new HandshakeError("FORBIDDEN", "Access denied");
    if (match.status !== "active") {
      throw new HandshakeError("MATCH_NOT_ACTIVE", "The match is not active");
    }
    return seat;
  }
}
