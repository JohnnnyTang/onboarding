# Contract: rules API

The interface between games and the platform. Implemented in `@bgp/schema` (types, validators) and `@bgp/rules` (runtime and SDK helpers). Contract version: **`sdk: 1`**.

## Basic types

```ts
/** Seats are numbered strings in seating order: "0", "1", ... */
export type SeatId = string;

/** JSON values allowed in match state. Numbers must be safe integers (D-006). */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A request to make a move. */
export interface MoveIntent {
  move: string; // key in GameDefinition.moves, or "manual" in sandbox mode
  args?: Json;
}

export interface GameResult {
  winners: SeatId[]; // empty array = no winner
  scores?: Record<SeatId, number>; // integers
  reason?: string; // short human-readable text
}
```

## Ctx

Runtime-managed. Games read it; only the runtime writes it.

```ts
export interface Ctx {
  seats: SeatId[]; // all seats, in seating order
  currentSeat: SeatId; // whose turn it is
  activeSeats: SeatId[]; // seats allowed to act now; defaults to [currentSeat]
  phase: string; // "main" when the game declares no phases
  turn: number; // starts at 1, +1 on each endTurn
  moveNumber: number; // number of accepted events so far
  options: Json; // match options from the lobby, validated against the manifest
}
```

`Ctx` is public: it is sent to every seat as part of the client view.

## Randomness

```ts
export interface Random {
  int(min: number, max: number): number; // inclusive both ends, integers only
  die(sides: number): number; // 1..sides
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[]; // returns a new array (Fisher–Yates)
  id(): string; // opaque, deterministic, unique within the match, e.g. "i8f3a2c91"
}
```

Backed by the match PRNG (D-006). If a move is rejected, its random draws are discarded with the rest of the draft.

## Events

Calls queue changes that the runtime applies after the move function returns.

```ts
export interface Events {
  endTurn(next?: SeatId): void; // next defaults to the turn order
  setPhase(phase: string): void;
  setActiveSeats(seats: SeatId[]): void; // e.g. everyone discards simultaneously
  endGame(result: GameResult): void;
}
```

## Move context and moves

```ts
export interface MoveContext extends Readonly<Ctx> {
  seat: SeatId; // the seat making this move (current seat inside turn/phase hooks)
  random: Random;
  events: Events;
}

export interface Invalid {
  invalid: true;
  code: string; // game-defined, SCREAMING_SNAKE_CASE, e.g. "NOT_ENOUGH_CARDS"
  message: string; // shown to the player
}

/** SDK helper */
export function invalid(code: string, message: string): Invalid;

export interface MoveDefinition<S extends Json, A extends Json = Json> {
  /** Validate and narrow untrusted args. Throw or return Invalid to reject. */
  parse?(args: Json | undefined): A | Invalid;
  /** Mutate the Immer draft. Return Invalid to reject; the draft is discarded. */
  apply(state: S, ctx: MoveContext, args: A): void | Invalid;
  /** Allow seats outside ctx.activeSeats to make this move. Default false. */
  anySeat?: boolean;
}
```

`apply` receives an Immer draft typed as `S`; mutate it, do not return a new state.

## Turns and phases

```ts
export interface TurnConfig<S extends Json> {
  /** Next seat after endTurn() with no argument. Default: next in ctx.seats, wrapping. */
  next?(state: S, ctx: Ctx): SeatId;
  onBegin?(state: S, ctx: MoveContext): void; // runs when a turn starts, including the first
  onEnd?(state: S, ctx: MoveContext): void;
}

export interface PhaseDefinition<S extends Json> {
  moves?: string[]; // moves allowed in this phase; default all
  onBegin?(state: S, ctx: MoveContext): void;
  onEnd?(state: S, ctx: MoveContext): void;
}
```

## Game definition

The default export of a game bundle.

```ts
export interface GameDefinition<S extends Json, V extends Json = Json> {
  sdk: 1;

  // ---- Authoritative (rules host; also hot-seat in the game worker) ----
  setup(init: SetupContext): S;
  moves: Record<string, MoveDefinition<S>>;
  turn?: TurnConfig<S>;
  phases?: Record<string, PhaseDefinition<S>>;
  startPhase?: string; // required if phases are declared
  endIf?(state: S, ctx: Ctx): GameResult | undefined;
  playerView(state: S, ctx: Ctx, seat: SeatId | null): V; // null = spectator
  legalMoves?(state: S, ctx: Ctx, seat: SeatId): MoveIntent[];

  // ---- Presentation (game worker only; inputs are views, never full state) ----
  present(view: ClientView<V>, info: PresentInfo): TableSnapshot;
  interpret?(gesture: Gesture, view: ClientView<V>, info: PresentInfo): MoveIntent | null;
  actions?(view: ClientView<V>, info: PresentInfo, selection: string[]): ActionButton[];
}

export interface SetupContext {
  seats: SeatId[];
  options: Json;
  random: Random;
}

export interface ClientView<V extends Json = Json> {
  ctx: Ctx;
  game: V;
  result: GameResult | null;
}

export interface PresentInfo {
  seat: SeatId | null; // the viewing seat; null = spectator
  components: ComponentsFile; // the version's declarations (components-and-table.md)
}

export interface ActionButton {
  id: string;
  label: string;
  enabled: boolean;
  intent?: MoveIntent; // sent when clicked; required if enabled
  hint?: string;
}
```

`TableSnapshot`, `Gesture` and `ComponentsFile` are defined in [components-and-table.md](components-and-table.md).

## Runtime API (`@bgp/rules`)

```ts
export interface MatchState<S extends Json = Json> {
  v: 1;
  game: S;
  ctx: Ctx;
  rng: [number, number, number, number]; // sfc32 state, uint32 each
  result: GameResult | null;
}

export function createMatch<S extends Json>(
  def: GameDefinition<S>,
  init: { seats: SeatId[]; seed: number; options: Json },
): MatchState<S>;

export type ApplyResult<S extends Json> =
  | { ok: true; state: MatchState<S>; event: AcceptedEvent }
  | { ok: false; code: RejectCode; gameCode?: string; message: string };

export function applyIntent<S extends Json>(
  def: GameDefinition<S>,
  state: MatchState<S>,
  seat: SeatId,
  intent: MoveIntent,
): ApplyResult<S>;

export function viewFor<S extends Json, V extends Json>(
  def: GameDefinition<S, V>,
  state: MatchState<S>,
  seat: SeatId | null,
): ClientView<V>;

export function hashState(state: MatchState): Promise<string>; // SHA-256 hex of canonical JSON

export function replay<S extends Json>(
  def: GameDefinition<S>,
  init: { seats: SeatId[]; seed: number; options: Json },
  events: AcceptedEvent[],
): MatchState<S>;

export interface AcceptedEvent {
  seq: number; // 1-based
  seat: SeatId;
  intent: MoveIntent;
}

export type RejectCode =
  | "MATCH_FINISHED"
  | "NOT_YOUR_TURN"
  | "MOVE_NOT_ALLOWED"
  | "UNKNOWN_MOVE"
  | "INVALID_ARGS"
  | "INVALID_MOVE"
  | "GAME_ERROR";
```

## Order of operations in `applyIntent`

1. If `state.result` is set → reject `MATCH_FINISHED`.
2. Look up `intent.move` → else `UNKNOWN_MOVE`.
3. If the current phase lists allowed moves and this is not one → `MOVE_NOT_ALLOWED`.
4. If `seat` is not in `ctx.activeSeats` and the move is not `anySeat` → `NOT_YOUR_TURN`.
5. `parse(args)` → `Invalid` or throw → `INVALID_ARGS`.
6. Create an Immer draft of `{ game, rng }`; run `apply`. `Invalid` → `INVALID_MOVE` (carry `gameCode` and message); throw → `GAME_ERROR`.
7. Apply queued events in this order: `setPhase` (old phase `onEnd`, new phase `onBegin`), `setActiveSeats`, `endTurn` (`turn.onEnd`, advance seat, `turn += 1`, reset `activeSeats`, `turn.onBegin`), `endGame`.
8. If no result yet, call `endIf`; a result finishes the match.
9. Validate the new state is integer-only JSON → else `GAME_ERROR` (the move is discarded).
10. `moveNumber += 1`; return the new state and the event.

`createMatch` runs `setup`, sets `currentSeat` to `seats[0]`, enters `startPhase` (its `onBegin`), then `turn.onBegin` for turn 1.

Runtime details for SDK 1 (reversible defaults tracked in Q-007):

- A seat must belong to the match even for `anySeat` moves. Omitted args are passed to
  `parse` as `undefined`; without a parser, `apply` receives `null`.
- Each callback receives a detached context snapshot. The move sees the acting seat;
  hooks see the current seat at the time they run. Writes to that snapshot do not
  change runtime context. State, intents, options and returned views are detached
  from caller-owned objects.
- Events form ordered batches. In each batch the last call of each kind wins, then
  phase, active seats, turn and result are applied in that order. Entering the same
  phase still runs its end/begin hooks. `endTurn` resets active seats to the next seat,
  so it supersedes `setActiveSeats` in the same batch.
- Hooks may queue events; these run in the next ordered batch. Initialization drains
  events after both initial hooks. A transaction allows at most 128 event calls, then
  fails atomically. Once a result is set, later batches are ignored.
- Invalid event inputs, unknown result seats and invalid custom turn-order results
  fail the transaction. Moves return void or `Invalid`; hooks return void.
- `endIf` runs only after accepted moves, after all events, and sees the previous
  `moveNumber`. Explicit `endGame` takes precedence. The accepted move increments
  `moveNumber` exactly once, irrespective of how many events it queued.
- Thrown parse errors use a fixed `INVALID_ARGS` message; thrown game/hook errors and
  invalid output use a fixed `GAME_ERROR` message. Only explicitly returned `Invalid`
  messages and codes are passed through to players.
- `viewFor` invokes only `playerView` on a detached game/context, and returns only its
  validated JSON output, public context and result. Invalid viewing seats and failures
  throw a fixed error. `createMatch` failures also throw a fixed error. The isolation
  host (T08) owns deadlines, global removal and containment of untrusted callbacks.
- Replay requires consecutive 1-based sequence numbers and accepted intents; gaps,
  duplicate sequences, malformed events and rejected intents throw a fixed error
  (including the safe runtime rejection code where applicable).

## Rules for game code

- Pure functions only. No `Date`, `Math.random`, timers, network, storage, DOM or Node APIs. The game worker and rules host remove them; code that relies on them fails.
- State is JSON with safe integers only. Use integer arithmetic; store money, scores and positions as integers.
- `playerView` must remove everything the seat may not know: other seats' hands, deck order, face-down identities. Replace hidden cards with counts or opaque IDs.
- Instance IDs come from `random.id()` and must not encode identity ("fish-3" is forbidden as an instance ID). After shuffling a hidden pile, give its items fresh IDs so they cannot be tracked.
- `present`, `interpret` and `actions` must be pure functions of their inputs.
- Time limit per call: 1000 ms by default (D-008). Keep moves fast.

## SDK helpers exported by `@bgp/rules`

`invalid`, `defineGame` (identity function for type inference), `rekey` (fresh IDs for a list of instances), `countHidden` (replace an array with its length for views), `seatsAfter` (turn-order helper).

```ts
export function rekey<T extends { id: string }>(items: readonly T[], random: Random): T[];
export function countHidden(items: readonly unknown[]): number;
/** All other seats, in order starting immediately after seat and wrapping. */
export function seatsAfter(seats: readonly SeatId[], seat: SeatId): SeatId[];
export function canonicalJson(value: unknown): string; // validates integer JSON, then serializes
```

`rekey` copies the instances without changing their order or other fields. `seatsAfter`
throws for an unknown seat. `Random.int` requires safe integer endpoints and a positive
safe integer span; it samples without modulo bias, using 32 bits (or 53 bits for wider
spans). Picking an empty array or rolling a nonpositive die throws. Shuffling returns a copy.

The uint32 seed expands to three words using the integer mixer
`x ^= x >>> 16; x = imul(x, 0x21f0aaad); x ^= x >>> 15;
x = imul(x, 0x735a2d97); x ^= x >>> 15`, applied to seed plus
`0x9e3779b9`, `0x3c6ef372` and `0xdaa66d2b` modulo 2^32. The fourth word starts
at 1; twelve sfc32 steps warm up the state. `Random.id` uses four output words as
an opaque 128-bit hexadecimal ID. These details are fixed for replay compatibility.

Canonical JSON sorts object keys lexically by UTF-16 code units, including numeric-looking
keys, and retains array order. Strings use JSON escaping, numbers normalize negative zero
to zero, and no whitespace is emitted. `hashState` hashes its UTF-8 bytes with Web Crypto
SHA-256 in Node and browsers. Only `hash.ts` may access this deterministic host capability;
game callbacks and the rest of the runtime cannot access cryptographic entropy APIs.

## Validation example

`MatchInitSchema` validates seats numbered from `"0"` in order (1–8 seats), a uint32
seed and integer-only options. `MatchStateSchema` also checks the four uint32 RNG words
and context membership. Runtime helpers above are implemented in T03.

<!-- schema: MatchInitSchema -->
```json
{ "seats": ["0", "1"], "seed": 123, "options": { "shortGame": false } }
```
