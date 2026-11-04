import type {
  ClientView,
  ComponentsFile,
  Gesture,
  MatchInit,
  MoveIntent,
  SeatId,
} from "@bgp/schema";

// Messages between the page and the game worker. The worker announces `WorkerBooted`; the
// page then posts one `WorkerInit` with a MessagePort, and every later request and reply goes
// over that port.

/** Posted by the worker on its global channel once its own code has loaded. */
export interface WorkerBooted {
  t: "booted";
}

export interface WorkerInit {
  t: "init";
  /** The version's `game.js`: one ES module with a default-exported GameDefinition. */
  source: string;
  components: ComponentsFile;
}

export type WorkerRequest =
  | { op: "present"; view: ClientView; seat: SeatId | null }
  | { op: "interpret"; gesture: Gesture; view: ClientView; seat: SeatId | null }
  | { op: "actions"; view: ClientView; seat: SeatId | null; selection: string[] }
  /** Hot-seat play: the worker holds the whole match locally (T15). */
  | { op: "hotSeatCreate"; init: MatchInit }
  | { op: "hotSeatApply"; seat: SeatId; intent: MoveIntent }
  | { op: "hotSeatView"; seat: SeatId | null };

export type WorkerCall = WorkerRequest & { id: number };

/**
 * A reply carries no error details: game errors can contain hidden state. The page treats
 * every `value` as untrusted and validates it.
 */
export type WorkerReply = { id: number; ok: true; value: unknown } | { id: number; ok: false };

/** The id of the reply to `WorkerInit`. Request ids start at 1. */
export const INIT_REPLY_ID = 0;
