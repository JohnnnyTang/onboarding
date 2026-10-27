import { z } from "zod";
import {
  GameCodeSchema,
  IdSchema,
  type Json,
  JsonSchema,
  NonnegativeIntegerSchema,
  PositiveIntegerSchema,
  RejectCodeSchema,
  type SeatId,
  SeatIdSchema,
  Uint32Schema,
  unique,
} from "./common.js";
import { ComponentsFileSchema, type Gesture, type TableSnapshot } from "./table.js";

export const MoveIntentSchema = z.strictObject({ move: IdSchema, args: JsonSchema.optional() });
export type MoveIntent = z.infer<typeof MoveIntentSchema>;
export const GameResultSchema = z.strictObject({
  winners: z.array(SeatIdSchema).refine(unique, "Duplicate winners"),
  scores: z.record(SeatIdSchema, z.int()).optional(),
  reason: z.string().optional(),
});
export type GameResult = z.infer<typeof GameResultSchema>;
export const SeatsSchema = z
  .array(SeatIdSchema)
  .min(1)
  .max(8)
  .refine(
    (seats) => seats.every((seat, index) => seat === String(index)),
    "Seats must be numbered in seating order starting at 0",
  );
export const CtxSchema = z
  .strictObject({
    seats: SeatsSchema,
    currentSeat: SeatIdSchema,
    activeSeats: z.array(SeatIdSchema).refine(unique, "Duplicate active seats"),
    phase: IdSchema,
    turn: PositiveIntegerSchema,
    moveNumber: NonnegativeIntegerSchema,
    options: JsonSchema,
  })
  .refine(
    (ctx) =>
      ctx.seats.includes(ctx.currentSeat) &&
      ctx.activeSeats.every((seat) => ctx.seats.includes(seat)),
    "Unknown context seat",
  );
export type Ctx = z.infer<typeof CtxSchema>;
export const InvalidSchema = z.strictObject({
  invalid: z.literal(true),
  code: GameCodeSchema,
  message: z.string(),
});
export type Invalid = z.infer<typeof InvalidSchema>;
export const ClientViewSchema = z.strictObject({
  ctx: CtxSchema,
  game: JsonSchema,
  result: GameResultSchema.nullable(),
});
export type ClientView<V extends Json = Json> = Omit<z.infer<typeof ClientViewSchema>, "game"> & {
  game: V;
};
export const MatchStateSchema = z
  .strictObject({
    v: z.literal(1),
    game: JsonSchema,
    ctx: CtxSchema,
    rng: z.tuple([Uint32Schema, Uint32Schema, Uint32Schema, Uint32Schema]),
    result: GameResultSchema.nullable(),
  })
  .refine(
    (state) => JsonSchema.safeParse(state).success,
    "Match state must contain only integer JSON",
  );
export type MatchState<S extends Json = Json> = Omit<z.infer<typeof MatchStateSchema>, "game"> & {
  game: S;
};
export const MatchInitSchema = z.strictObject({
  seats: SeatsSchema,
  seed: Uint32Schema,
  options: JsonSchema,
});
export type MatchInit = z.infer<typeof MatchInitSchema>;
export const AcceptedEventSchema = z.strictObject({
  seq: PositiveIntegerSchema,
  seat: SeatIdSchema,
  intent: MoveIntentSchema,
});
export type AcceptedEvent = z.infer<typeof AcceptedEventSchema>;
export const ApplyResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), state: MatchStateSchema, event: AcceptedEventSchema }),
  z.strictObject({
    ok: z.literal(false),
    code: RejectCodeSchema,
    gameCode: GameCodeSchema.optional(),
    message: z.string(),
  }),
]);
export type ApplyResult<S extends Json> =
  | { ok: true; state: MatchState<S>; event: AcceptedEvent }
  | { ok: false; code: z.infer<typeof RejectCodeSchema>; gameCode?: string; message: string };
export const ActionButtonSchema = z
  .strictObject({
    id: IdSchema,
    label: z.string(),
    enabled: z.boolean(),
    intent: MoveIntentSchema.optional(),
    hint: z.string().optional(),
  })
  .refine(
    (button) => !button.enabled || button.intent !== undefined,
    "Enabled actions require an intent",
  );
export type ActionButton = z.infer<typeof ActionButtonSchema>;

export interface Random {
  int(min: number, max: number): number;
  die(sides: number): number;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];
  id(): string;
}
export interface Events {
  endTurn(next?: SeatId): void;
  setPhase(phase: string): void;
  setActiveSeats(seats: SeatId[]): void;
  endGame(result: GameResult): void;
}
export interface MoveContext extends Readonly<Ctx> {
  seat: SeatId;
  random: Random;
  events: Events;
}
export interface SetupContext {
  seats: SeatId[];
  options: Json;
  random: Random;
}
export interface MoveDefinition<S extends Json, A extends Json = Json> {
  parse?(args: Json | undefined): A | Invalid;
  // biome-ignore lint/suspicious/noConfusingVoidType: The rules contract allows mutation with no return or an Invalid result.
  apply(state: S, ctx: MoveContext, args: A): void | Invalid;
  anySeat?: boolean;
}
export interface TurnConfig<S extends Json> {
  next?(state: S, ctx: Ctx): SeatId;
  onBegin?(state: S, ctx: MoveContext): void;
  onEnd?(state: S, ctx: MoveContext): void;
}
export interface PhaseDefinition<S extends Json> {
  moves?: string[];
  onBegin?(state: S, ctx: MoveContext): void;
  onEnd?(state: S, ctx: MoveContext): void;
}
export const PresentInfoSchema = z.strictObject({
  seat: SeatIdSchema.nullable(),
  components: ComponentsFileSchema,
});
export type PresentInfo = z.infer<typeof PresentInfoSchema>;
export interface GameDefinition<S extends Json, V extends Json = Json> {
  sdk: 1;
  setup(init: SetupContext): S;
  moves: Record<string, MoveDefinition<S>>;
  turn?: TurnConfig<S>;
  phases?: Record<string, PhaseDefinition<S>>;
  startPhase?: string;
  endIf?(state: S, ctx: Ctx): GameResult | undefined;
  playerView(state: S, ctx: Ctx, seat: SeatId | null): V;
  legalMoves?(state: S, ctx: Ctx, seat: SeatId): MoveIntent[];
  present(view: ClientView<V>, info: PresentInfo): TableSnapshot;
  interpret?(gesture: Gesture, view: ClientView<V>, info: PresentInfo): MoveIntent | null;
  actions?(view: ClientView<V>, info: PresentInfo, selection: string[]): ActionButton[];
}

// Bundle inspection checks callability only. Executing untrusted functions belongs in T08.
const CallableSchema = z.custom<(...args: never[]) => unknown>(
  (value) => typeof value === "function",
);
export const RandomSchema = z.strictObject({
  int: CallableSchema,
  die: CallableSchema,
  pick: CallableSchema,
  shuffle: CallableSchema,
  id: CallableSchema,
});
export const EventsSchema = z.strictObject({
  endTurn: CallableSchema,
  setPhase: CallableSchema,
  setActiveSeats: CallableSchema,
  endGame: CallableSchema,
});
export const SetupContextSchema = z.strictObject({
  seats: SeatsSchema,
  options: JsonSchema,
  random: RandomSchema,
});
export const MoveContextSchema = CtxSchema.safeExtend({
  seat: SeatIdSchema,
  random: RandomSchema,
  events: EventsSchema,
});
export const MoveDefinitionSchema = z.strictObject({
  parse: CallableSchema.optional(),
  apply: CallableSchema,
  anySeat: z.boolean().optional(),
});
export const TurnConfigSchema = z.strictObject({
  next: CallableSchema.optional(),
  onBegin: CallableSchema.optional(),
  onEnd: CallableSchema.optional(),
});
export const PhaseDefinitionSchema = z.strictObject({
  moves: z.array(IdSchema).optional(),
  onBegin: CallableSchema.optional(),
  onEnd: CallableSchema.optional(),
});
export const GameDefinitionSchema = z
  .strictObject({
    sdk: z.literal(1),
    setup: CallableSchema,
    moves: z.record(IdSchema, MoveDefinitionSchema),
    turn: TurnConfigSchema.optional(),
    phases: z.record(IdSchema, PhaseDefinitionSchema).optional(),
    startPhase: IdSchema.optional(),
    endIf: CallableSchema.optional(),
    playerView: CallableSchema,
    legalMoves: CallableSchema.optional(),
    present: CallableSchema,
    interpret: CallableSchema.optional(),
    actions: CallableSchema.optional(),
  })
  .refine(
    (def) =>
      def.phases === undefined
        ? def.startPhase === undefined
        : def.startPhase !== undefined && Object.hasOwn(def.phases, def.startPhase),
    "Invalid start phase",
  )
  .refine(
    (def) =>
      Object.values(def.phases ?? {}).every(
        (phase) => phase.moves?.every((move) => Object.hasOwn(def.moves, move)) ?? true,
      ),
    "Unknown phase move",
  );
