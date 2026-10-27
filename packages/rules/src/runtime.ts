import {
  type AcceptedEvent,
  AcceptedEventSchema,
  type ApplyResult,
  type ClientView,
  ClientViewSchema,
  type GameDefinition,
  GameDefinitionSchema,
  type Invalid,
  InvalidSchema,
  type Json,
  JsonSchema,
  type MatchInit,
  MatchInitSchema,
  type MatchState,
  MatchStateSchema,
  type MoveIntent,
  MoveIntentSchema,
  type RejectCode,
  type SeatId,
} from "@bgp/schema";
import { Immer } from "immer";
import { cloneJson } from "./canonical.js";
import { eventQueue, validateResult } from "./events.js";
import { createRandom, seedRandom } from "./random.js";

const immer = new Immer({ autoFreeze: false });
type Rejection = Extract<ApplyResult<Json>, { ok: false }>;

function reject(code: RejectCode, message: string, invalid?: Invalid): Rejection {
  return invalid
    ? { ok: false, code, gameCode: invalid.code, message: invalid.message }
    : { ok: false, code, message };
}

class RejectedMove extends Error {
  constructor(readonly rejection: Rejection) {
    super(rejection.code);
  }
}

function asInvalid(value: unknown): Invalid | undefined {
  if (typeof value === "object" && value !== null && "invalid" in value && value.invalid === true) {
    return InvalidSchema.parse(value);
  }
  return undefined;
}

export function createMatch<S extends Json, V extends Json = Json>(
  def: GameDefinition<S, V>,
  init: MatchInit,
): MatchState<S> {
  try {
    GameDefinitionSchema.parse(def);
    const input = cloneJson(MatchInitSchema.parse(init));
    const rng = seedRandom(input.seed);
    const random = createRandom(rng);
    const first = input.seats[0];
    if (first === undefined) throw new Error("Missing seats");
    const game = def.setup({ seats: [...input.seats], options: cloneJson(input.options), random });
    JsonSchema.parse(game);
    const initial: MatchState<S> = {
      v: 1,
      game: cloneJson(game),
      ctx: {
        seats: input.seats,
        currentSeat: first,
        activeSeats: [first],
        phase: def.startPhase ?? "main",
        turn: 1,
        moveNumber: 0,
        options: input.options,
      },
      rng,
      result: null,
    };
    const queue = eventQueue(def, initial, random);
    queue.hook(def.phases?.[initial.ctx.phase]?.onBegin);
    queue.hook(def.turn?.onBegin);
    queue.flush();
    MatchStateSchema.parse(initial);
    return cloneJson(initial);
  } catch {
    throw new Error("Game initialization failed");
  }
}

export function applyIntent<S extends Json, V extends Json = Json>(
  def: GameDefinition<S, V>,
  state: MatchState<S>,
  seat: SeatId,
  intent: MoveIntent,
): ApplyResult<S> {
  try {
    MatchStateSchema.parse(state);
    if (state.result !== null) return reject("MATCH_FINISHED", "The match has finished");
    const move = Object.hasOwn(def.moves, intent.move) ? def.moves[intent.move] : undefined;
    if (!move) return reject("UNKNOWN_MOVE", "Unknown move");
    const allowed = def.phases?.[state.ctx.phase]?.moves;
    if (allowed && !allowed.includes(intent.move)) {
      return reject("MOVE_NOT_ALLOWED", "Move is not allowed in this phase");
    }
    if (
      !state.ctx.seats.includes(seat) ||
      (!move.anySeat && !state.ctx.activeSeats.includes(seat))
    ) {
      return reject("NOT_YOUR_TURN", "This seat cannot act now");
    }
    let args: Json;
    let acceptedIntent: MoveIntent;
    try {
      acceptedIntent = cloneJson(MoveIntentSchema.parse(intent));
      const parsed = move.parse
        ? move.parse(
            acceptedIntent.args === undefined ? undefined : cloneJson(acceptedIntent.args),
            { state: cloneJson(state.game), ctx: cloneJson(state.ctx), seat },
          )
        : (acceptedIntent.args ?? null);
      const invalid = asInvalid(parsed);
      if (invalid) return reject("INVALID_ARGS", "Invalid arguments", invalid);
      args = cloneJson(JsonSchema.parse(parsed));
    } catch {
      return reject("INVALID_ARGS", "Invalid arguments");
    }
    const next = immer.produce(cloneJson(state), (draft) => {
      // The validated JSON state is draftable; S may also be a primitive JSON value.
      const transaction = draft as MatchState<S>;
      const queue = eventQueue(def, transaction, createRandom(transaction.rng));
      const returned = move.apply(transaction.game, queue.context(seat), args);
      const invalid = asInvalid(returned);
      if (invalid) throw new RejectedMove(reject("INVALID_MOVE", "Invalid move", invalid));
      if (returned !== undefined) throw new Error("Moves must mutate and return void or Invalid");
      queue.flush();
      if (transaction.result === null) {
        const result = def.endIf?.(cloneJson(transaction.game), cloneJson(transaction.ctx));
        if (result !== undefined) transaction.result = validateResult(result, transaction.ctx);
      }
      MatchStateSchema.parse(transaction);
      transaction.ctx.moveNumber += 1;
      MatchStateSchema.parse(transaction);
    });
    // Detach objects assigned to the draft from references retained by game callbacks.
    return {
      ok: true,
      state: cloneJson(next),
      event: { seq: next.ctx.moveNumber, seat, intent: acceptedIntent },
    };
  } catch (error) {
    if (error instanceof RejectedMove) return error.rejection;
    // Game exceptions can contain hidden state. Never return their text or stack.
    return reject("GAME_ERROR", "Game execution failed");
  }
}

export function viewFor<S extends Json, V extends Json>(
  def: GameDefinition<S, V>,
  state: MatchState<S>,
  seat: SeatId | null,
): ClientView<V> {
  try {
    MatchStateSchema.parse(state);
    if (seat !== null && !state.ctx.seats.includes(seat)) throw new Error("Unknown seat");
    const ctx = cloneJson(state.ctx);
    const game = def.playerView(cloneJson(state.game), cloneJson(ctx), seat);
    const view = { ctx, game, result: cloneJson(state.result) };
    ClientViewSchema.parse(view);
    return cloneJson(view);
  } catch {
    throw new Error("Game view failed");
  }
}

export function replay<S extends Json, V extends Json = Json>(
  def: GameDefinition<S, V>,
  init: MatchInit,
  events: AcceptedEvent[],
): MatchState<S> {
  let state = createMatch(def, init);
  for (const input of events) {
    const parsed = AcceptedEventSchema.safeParse(input);
    if (!parsed.success || parsed.data.seq !== state.ctx.moveNumber + 1) {
      throw new Error("Invalid replay sequence");
    }
    const result = applyIntent(def, state, parsed.data.seat, parsed.data.intent);
    if (!result.ok) throw new Error(`Replay event rejected: ${result.code}`);
    state = result.state;
  }
  return state;
}
