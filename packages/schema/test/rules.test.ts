import { describe, expect, expectTypeOf, test } from "vitest";
import {
  AcceptedEventSchema,
  ActionButtonSchema,
  ApplyResultSchema,
  ClientViewSchema,
  CtxSchema,
  type GameDefinition,
  GameDefinitionSchema,
  GameResultSchema,
  type Json,
  JsonSchema,
  MatchInitSchema,
  MatchStateSchema,
  MoveContextSchema,
  type MoveDefinition,
  type TableRenderer,
  type TableSnapshot,
  TableSnapshotSchema,
} from "../src/index.js";
import { ctx, snapshot, state, view } from "./fixtures.js";

describe("integer-only JSON and runtime contracts", () => {
  test("preserves arbitrary JSON keys without prototype mutation", () => {
    const input: unknown = JSON.parse('{"__proto__":{"value":1},"nested":[{"constructor":2}]}');
    expect(JsonSchema.parse(input)).toEqual(input);
    expect(JSON.stringify(JsonSchema.parse(input))).toBe(JSON.stringify(input));
    expect(Object.getPrototypeOf(JsonSchema.parse(input))).toBe(Object.prototype);
  });
  test("accepts recursive JSON, safe integer endpoints and shared objects", () => {
    const shared = { value: 1 };
    for (const value of [
      null,
      true,
      "hello",
      Number.MAX_SAFE_INTEGER,
      Number.MIN_SAFE_INTEGER,
      [],
      {},
      [shared, shared],
    ]) {
      expect(JsonSchema.parse(value)).toEqual(value);
    }
    expect(MatchStateSchema.parse(state)).toEqual(state);
    expect(ClientViewSchema.parse(view)).toEqual(view);
    expect(
      MatchInitSchema.parse({ seats: ["0", "1"], seed: 0xffff_ffff, options: {} }),
    ).toBeDefined();
  });
  test.each([
    0.1,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    undefined,
    [undefined],
    { x: undefined },
    new Map(),
    new Set(),
    new Date(),
    BigInt(1),
    () => 1,
    Symbol("bad"),
    new Array(2),
    Object.assign({}, { [Symbol("x")]: 1 }),
  ])("rejects non-JSON input %#", (value) => {
    expect(JsonSchema.safeParse(value).success).toBe(false);
  });
  test("rejects cycles and non-JSON class instances without throwing", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    class Impostor {
      value = 1;
    }
    expect(JsonSchema.safeParse(cyclic).success).toBe(false);
    expect(JsonSchema.safeParse(new Impostor()).success).toBe(false);
  });
  test.each([
    { ...state, game: { price: 1.5 } },
    { ...state, rng: [1, 2, 3, -1] },
    { ...state, rng: [1, 2, 3, 0x1_0000_0000] },
    { ...state, result: { winners: [], reason: undefined } },
    { ...state, ctx: { ...ctx, currentSeat: "3" } },
    { ...state, ctx: { ...ctx, activeSeats: ["2"] } },
    { ...state, ctx: { ...ctx, seats: ["1", "0"] } },
    { ...state, ctx: { ...ctx, turn: 0 } },
  ])("rejects invalid match state %#", (value) => {
    expect(MatchStateSchema.safeParse(value).success).toBe(false);
  });
  test("public views reject server fields at the envelope and ctx boundaries", () => {
    expect(ClientViewSchema.safeParse({ ...view, rng: [1, 2, 3, 4] }).success).toBe(false);
    expect(ClientViewSchema.safeParse({ ...view, ctx: { ...ctx, seed: 1 } }).success).toBe(false);
    expect(GameResultSchema.safeParse({ winners: ["0"], scores: { "0": 1.2 } }).success).toBe(
      false,
    );
    expect(ActionButtonSchema.safeParse({ id: "ship", label: "Ship", enabled: true }).success).toBe(
      false,
    );
    expect(
      ActionButtonSchema.parse({
        id: "ship",
        label: "Ship",
        enabled: true,
        intent: { move: "ship" },
      }),
    ).toBeDefined();
    expect(
      AcceptedEventSchema.safeParse({ seq: 0, seat: "0", intent: { move: "ship" } }).success,
    ).toBe(false);
    expect(
      ApplyResultSchema.parse({
        ok: false,
        code: "INVALID_MOVE",
        gameCode: "NO_CARDS",
        message: "No cards",
      }),
    ).toBeDefined();
  });
  test("callable contracts inspect shape without executing game code", () => {
    const fail = () => {
      throw new Error("must not run");
    };
    const game = {
      sdk: 1,
      setup: fail,
      moves: { draw: { apply: fail } },
      playerView: fail,
      present: fail,
      phases: { main: { moves: ["draw"], onBegin: fail } },
      startPhase: "main",
    };
    expect(GameDefinitionSchema.parse(game)).toBeDefined();
    expect(GameDefinitionSchema.safeParse({ ...game, setup: "function" }).success).toBe(false);
    expect(GameDefinitionSchema.safeParse({ ...game, startPhase: "missing" }).success).toBe(false);
    expect(
      GameDefinitionSchema.safeParse({ ...game, phases: { main: { moves: ["missing"] } } }).success,
    ).toBe(false);
    expect(MoveContextSchema.safeParse({ ...ctx, seat: "0", random: {}, events: {} }).success).toBe(
      false,
    );
  });
});

test("SDK types support narrowed moves, generic views and renderer containers", () => {
  type State = { count: number };
  const increment: MoveDefinition<State, { amount: number }> = {
    parse() {
      return { amount: 1 };
    },
    apply(draft, _ctx, args) {
      draft.count += args.amount;
    },
  };
  const game: GameDefinition<State, { count: number }> = {
    sdk: 1,
    setup() {
      return { count: 0 };
    },
    moves: { increment },
    playerView(value) {
      return value;
    },
    present() {
      return TableSnapshotSchema.parse(snapshot);
    },
  };
  expectTypeOf(game.setup).returns.toEqualTypeOf<State>();
  expectTypeOf<TableRenderer<{ host: string }>["setSnapshot"]>()
    .parameter(0)
    .toEqualTypeOf<TableSnapshot>();
  expectTypeOf<Json>().toEqualTypeOf<
    null | boolean | number | string | Json[] | { [key: string]: Json }
  >();
  expect(CtxSchema.parse(ctx)).toEqual(ctx);
});
