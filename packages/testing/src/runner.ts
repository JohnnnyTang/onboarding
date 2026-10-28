import {
  applyIntent,
  canonicalJson,
  createMatch,
  createRandom,
  hashState,
  seedRandom,
} from "@bgp/rules";
import {
  type AcceptedEvent,
  type GameDefinition,
  type Json,
  type MatchInit,
  type MatchState,
  type MoveIntent,
  MoveIntentSchema,
  type Random,
  type SeatId,
} from "@bgp/schema";

/** Detach callbacks and test artifacts from the authoritative runtime objects. */
export function copy<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

export type Bot<S extends Json, V extends Json> = (
  def: GameDefinition<S, V>,
  state: MatchState<S>,
  seat: SeatId,
  random: Random,
) => MoveIntent | null;

/** Uniformly choose a declared legal move; no moves means this seat cannot act. */
export function randomBot<S extends Json, V extends Json>(
  def: GameDefinition<S, V>,
  state: MatchState<S>,
  seat: SeatId,
  random: Random,
): MoveIntent | null {
  if (!state.ctx.seats.includes(seat)) throw new Error("Unknown bot seat");
  if (state.result !== null) return null;
  if (!def.legalMoves) throw new Error("randomBot requires legalMoves or a custom bot");
  const detached = copy(state);
  const moves = def.legalMoves(detached.game, detached.ctx, seat);
  const validated = moves.map((move) => MoveIntentSchema.parse(move));
  return validated.length === 0 ? null : copy(random.pick(validated));
}

export interface RunStep<S extends Json> {
  state: MatchState<S>;
  hash: string;
}

export interface MatchRun<S extends Json> {
  init: MatchInit;
  events: AcceptedEvent[];
  /** Includes setup at index 0 and every accepted event thereafter. */
  steps: RunStep<S>[];
  stop: "finished" | "no-legal-moves" | "move-limit";
}

export interface RunOptions<S extends Json, V extends Json> {
  maxMoves?: number;
  /** Bot randomness never consumes the authoritative match RNG. */
  botSeed?: number;
  bot?: Bot<S, V>;
  onStep?(step: RunStep<S>): void | Promise<void>;
}

export async function runMatch<S extends Json, V extends Json>(
  def: GameDefinition<S, V>,
  init: MatchInit,
  options: RunOptions<S, V> = {},
): Promise<MatchRun<S>> {
  const maxMoves = options.maxMoves ?? 1000;
  if (!Number.isSafeInteger(maxMoves) || maxMoves < 0) {
    throw new Error("maxMoves must be a nonnegative safe integer");
  }
  const input = copy(init);
  const random = createRandom(seedRandom(options.botSeed ?? input.seed));
  const bot = options.bot ?? randomBot;
  let state = createMatch(def, input);
  const events: AcceptedEvent[] = [];
  const steps: RunStep<S>[] = [];
  async function record() {
    const step = { state: copy(state), hash: await hashState(state) };
    steps.push(step);
    await options.onStep?.({ state: copy(step.state), hash: step.hash });
  }
  await record();
  while (state.result === null && events.length < maxMoves) {
    // Try the current seat first, then every other seat (simultaneous/anySeat moves).
    const seats = [
      state.ctx.currentSeat,
      ...state.ctx.seats.filter((s) => s !== state.ctx.currentSeat),
    ];
    let selected: { seat: SeatId; intent: MoveIntent } | undefined;
    for (const seat of seats) {
      const intent = bot(def, copy(state), seat, random);
      if (intent !== null) {
        selected = { seat, intent: MoveIntentSchema.parse(intent) };
        break;
      }
    }
    if (!selected) return { init: input, events, steps, stop: "no-legal-moves" };
    const result = applyIntent(def, state, selected.seat, selected.intent);
    if (!result.ok) {
      throw new Error(`Bot move rejected at seq ${state.ctx.moveNumber + 1}: ${result.code}`);
    }
    state = result.state;
    events.push(result.event);
    await record();
  }
  return { init: input, events, steps, stop: state.result === null ? "move-limit" : "finished" };
}
