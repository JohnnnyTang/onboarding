import {
  type ClientMessage,
  type ClientView,
  type ErrorCode,
  type GameResult,
  type MatchSummary,
  type MoveIntent,
  PROTOCOL_VERSION,
  type SeatId,
  type ServerMessage,
  ServerMessageSchema,
} from "@bgp/schema";
import { applyViewPatch } from "./view-patch";

/** Credentials for `hello`: a guest token for this match or the designer's access token. */
export interface RoomAuth {
  kind: "user" | "guest";
  token: string;
}

/** The parts of the browser WebSocket the client uses, so tests can supply a fake. */
export interface RoomSocket {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number): void;
}

export type RoomStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface ChatEntry {
  from: SeatId;
  name: string;
  text: string;
  at: string;
}

/** A move the server did not apply. `id` grows so the same message can be shown again. */
export interface Rejection {
  id: number;
  code: ErrorCode;
  gameCode?: string;
  message: string;
}

export interface RoomError {
  code: ErrorCode;
  message: string;
  fatal: boolean;
}

export interface RoomState {
  status: RoomStatus;
  seat: SeatId | null;
  match: MatchSummary | null;
  seq: number;
  /** This seat's view, rebuilt from `welcome`, patches and snapshots. */
  view: ClientView | null;
  result: GameResult | null;
  chat: readonly ChatEntry[];
  rejected: Rejection | null;
  /** The last `error` from the server; fatal ones end the connection for good. */
  error: RoomError | null;
  /** True between sending a move and its acknowledgement (patch, snapshot or rejection). */
  movePending: boolean;
}

export interface RoomClientOptions {
  url: string;
  matchId: string;
  /** Read on every connection attempt; null means there is nothing to connect with. */
  auth(): RoomAuth | null;
  createSocket?(url: string): RoomSocket;
  setTimeout?(callback: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
  /** A number in [0, 1) for reconnect jitter. */
  random?(): number;
}

export interface RoomClient {
  getState(): RoomState;
  subscribe(listener: () => void): () => void;
  connect(): void;
  /** Sends a move; false when there is no open connection. */
  move(intent: MoveIntent): boolean;
  chat(text: string): boolean;
  resync(): void;
  close(): void;
}

/** Delays before reconnect attempts 1, 2, 3, ...; the last one repeats. */
export const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000] as const;
export const RECONNECT_JITTER_MS = 250;
export const CHAT_HISTORY = 200;
const OPEN = 1;

/** Fatal errors after which a new connection cannot succeed without user action. */
const FINAL_ERRORS = new Set<ErrorCode>([
  "PROTOCOL_VERSION",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "MATCH_NOT_FOUND",
  "MATCH_NOT_ACTIVE",
  "SEAT_TAKEN_OVER",
]);

export const INITIAL_ROOM_STATE: RoomState = {
  status: "connecting",
  seat: null,
  match: null,
  seq: 0,
  view: null,
  result: null,
  chat: [],
  rejected: null,
  error: null,
  movePending: false,
};

export function reconnectDelay(attempt: number, random: number): number {
  const base =
    RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)] ??
    RECONNECT_DELAYS_MS[0];
  return base + Math.floor(random * RECONNECT_JITTER_MS);
}

function parseFrame(data: unknown): ServerMessage | null {
  if (typeof data !== "string") return null;
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = ServerMessageSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/**
 * The room server connection for one seat (contracts/protocol.md): `hello`, patches applied to
 * the seat's view, `resync` on gaps or failed patches, and reconnects with backoff. Every
 * frame is validated with `ServerMessageSchema`; anything else is ignored.
 */
export function createRoomClient(options: RoomClientOptions): RoomClient {
  const createSocket =
    options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as RoomSocket);
  const schedule = options.setTimeout ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
  const cancel =
    options.clearTimeout ??
    ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>));
  const random = options.random ?? Math.random;

  let state: RoomState = INITIAL_ROOM_STATE;
  const listeners = new Set<() => void>();
  let socket: RoomSocket | null = null;
  let timer: unknown = null;
  let attempts = 0;
  let clientSeq = 0;
  let pendingSeq: number | null = null;
  let resyncing = false;
  let stopped = false;
  let rejections = 0;

  function update(patch: Partial<RoomState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }

  function send(message: ClientMessage): boolean {
    if (!socket || socket.readyState !== OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  function requestResync(): void {
    if (resyncing) return;
    resyncing = true;
    send({ t: "resync" });
  }

  function acknowledge(seq: number | undefined): void {
    if (pendingSeq !== null && (seq === undefined || seq === pendingSeq)) {
      pendingSeq = null;
      update({ movePending: false });
    }
  }

  function receive(message: ServerMessage): void {
    switch (message.t) {
      case "welcome":
        attempts = 0;
        resyncing = false;
        pendingSeq = null;
        update({
          status: "open",
          seat: message.seat,
          match: message.match,
          seq: message.seq,
          view: message.view,
          result: message.view.result,
          error: null,
          movePending: false,
        });
        return;
      case "patch": {
        if (resyncing || !state.view) return;
        const view = message.seq === state.seq + 1 ? applyViewPatch(state.view, message.ops) : null;
        if (!view) {
          // A gap in seq, or operations that do not apply to this view.
          requestResync();
          return;
        }
        update({ seq: message.seq, view, result: view.result ?? state.result });
        if (message.cause.clientSeq !== undefined) acknowledge(message.cause.clientSeq);
        return;
      }
      case "snapshot":
        resyncing = false;
        update({ seq: message.seq, view: message.view, result: message.view.result });
        // A snapshot also acknowledges a move whose change was too large for a patch.
        acknowledge(undefined);
        return;
      case "rejected":
        rejections += 1;
        update({
          rejected: {
            id: rejections,
            code: message.code,
            message: message.message,
            ...(message.gameCode === undefined ? {} : { gameCode: message.gameCode }),
          },
        });
        acknowledge(message.clientSeq);
        return;
      case "presence":
        if (state.match) update({ match: { ...state.match, seats: message.seats } });
        return;
      case "chat":
        update({
          chat: [
            ...state.chat.slice(-(CHAT_HISTORY - 1)),
            { from: message.from, name: message.name, text: message.text, at: message.at },
          ],
        });
        return;
      case "ended":
        update({ result: message.result });
        return;
      case "error": {
        const error = { code: message.code, message: message.message, fatal: message.fatal };
        if (message.fatal && FINAL_ERRORS.has(message.code)) stopped = true;
        update({ error });
        return;
      }
      case "ephemeral":
      case "pong":
        return;
    }
  }

  function scheduleReconnect(): void {
    if (stopped) {
      update({ status: "closed", movePending: false });
      return;
    }
    update({ status: "reconnecting", movePending: false });
    const delay = reconnectDelay(attempts, random());
    attempts += 1;
    timer = schedule(() => {
      timer = null;
      open();
    }, delay);
  }

  function open(): void {
    if (stopped) return;
    const auth = options.auth();
    if (!auth) {
      stopped = true;
      update({
        status: "closed",
        error: { code: "UNAUTHORIZED", message: "Sign in or rejoin to continue.", fatal: true },
      });
      return;
    }
    clientSeq = 0;
    pendingSeq = null;
    resyncing = false;
    const current = createSocket(options.url);
    socket = current;
    current.onopen = () => {
      if (socket !== current) return;
      send({
        t: "hello",
        protocol: PROTOCOL_VERSION,
        matchId: options.matchId,
        auth: { kind: auth.kind, token: auth.token },
        ...(state.view ? { lastSeq: state.seq } : {}),
      });
    };
    current.onmessage = (event) => {
      if (socket !== current) return;
      const message = parseFrame(event.data);
      if (message) receive(message);
    };
    current.onerror = () => {};
    current.onclose = () => {
      if (socket !== current) return;
      socket = null;
      scheduleReconnect();
    };
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    connect() {
      if (socket || timer !== null || stopped) return;
      update({ status: state.view ? "reconnecting" : "connecting" });
      open();
    },
    move(intent) {
      const seq = clientSeq;
      if (state.status !== "open" || !send({ t: "move", clientSeq: seq, intent })) return false;
      clientSeq += 1;
      pendingSeq = seq;
      update({ movePending: true });
      return true;
    },
    chat(text) {
      return state.status === "open" && send({ t: "chat", text });
    },
    resync: requestResync,
    close() {
      stopped = true;
      if (timer !== null) cancel(timer);
      timer = null;
      const current = socket;
      socket = null;
      current?.close(1000);
      update({ status: "closed", movePending: false });
    },
  };
}
