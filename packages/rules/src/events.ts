import {
  type Ctx,
  type Events,
  type GameDefinition,
  type GameResult,
  GameResultSchema,
  type Json,
  type MatchState,
  type MoveContext,
  type Random,
  type SeatId,
} from "@bgp/schema";
import { cloneJson } from "./canonical.js";

type QueuedEvent =
  | { kind: "phase"; phase: string }
  | { kind: "active"; seats: SeatId[] }
  | { kind: "turn"; next: SeatId | undefined }
  | { kind: "game"; result: GameResult };

export function validateResult(result: unknown, ctx: Ctx): GameResult {
  const parsed = GameResultSchema.parse(result);
  if (
    !parsed.winners.every((seat) => ctx.seats.includes(seat)) ||
    !Object.keys(parsed.scores ?? {}).every((seat) => ctx.seats.includes(seat))
  ) {
    throw new Error("Unknown result seat");
  }
  return cloneJson(parsed);
}

/** A fresh, isolated event queue for each transaction, including initialization. */
export function eventQueue<S extends Json, V extends Json>(
  def: GameDefinition<S, V>,
  state: MatchState<S>,
  random: Random,
) {
  let queued: QueuedEvent[] = [];
  let count = 0;
  function enqueue(event: QueuedEvent): void {
    count += 1;
    if (count > 128) throw new Error("Event cascade limit exceeded");
    queued.push(event);
  }
  function requireSeat(seat: SeatId): void {
    if (!state.ctx.seats.includes(seat)) throw new Error("Unknown seat");
  }
  const events: Events = {
    endTurn(next) {
      if (next !== undefined) requireSeat(next);
      enqueue({ kind: "turn", next });
    },
    setPhase(phase) {
      if (!Object.hasOwn(def.phases ?? {}, phase)) throw new Error("Unknown phase");
      enqueue({ kind: "phase", phase });
    },
    setActiveSeats(seats) {
      if (!Array.isArray(seats)) throw new Error("Active seats must be an array");
      if (new Set(seats).size !== seats.length) throw new Error("Duplicate active seats");
      for (const seat of seats) requireSeat(seat);
      enqueue({ kind: "active", seats: [...seats] });
    },
    endGame(result) {
      enqueue({ kind: "game", result: validateResult(result, state.ctx) });
    },
  };
  function context(seat: SeatId): MoveContext {
    return { ...cloneJson(state.ctx), seat, random, events };
  }
  function hook(callback: ((game: S, ctx: MoveContext) => void) | undefined): void {
    const returned: unknown = callback?.(state.game, context(state.ctx.currentSeat));
    if (returned !== undefined) throw new Error("Hooks must return void");
  }
  function flush(): void {
    while (queued.length > 0 && state.result === null) {
      const batch = queued.reverse();
      queued = [];
      // Last call of each kind wins within a batch, regardless of enqueue order.
      const phase = batch.find((event) => event.kind === "phase");
      const active = batch.find((event) => event.kind === "active");
      const turn = batch.find((event) => event.kind === "turn");
      const game = batch.find((event) => event.kind === "game");
      if (phase?.kind === "phase") {
        hook(def.phases?.[state.ctx.phase]?.onEnd);
        state.ctx.phase = phase.phase;
        hook(def.phases?.[state.ctx.phase]?.onBegin);
      }
      if (active?.kind === "active") state.ctx.activeSeats = active.seats;
      if (turn?.kind === "turn") {
        hook(def.turn?.onEnd);
        const next =
          turn.next !== undefined
            ? turn.next
            : def.turn?.next
              ? def.turn.next(cloneJson(state.game), cloneJson(state.ctx))
              : state.ctx.seats[
                  (state.ctx.seats.indexOf(state.ctx.currentSeat) + 1) % state.ctx.seats.length
                ];
        if (next === undefined) throw new Error("Missing next seat");
        requireSeat(next);
        state.ctx.currentSeat = next;
        state.ctx.turn += 1;
        state.ctx.activeSeats = [next];
        hook(def.turn?.onBegin);
      }
      if (game?.kind === "game") state.result = game.result;
    }
  }
  return { context, hook, flush };
}
