import { applyIntent, createMatch, viewFor } from "@bgp/rules";
import type { MatchState, MoveIntent } from "@bgp/schema";
import { describe, expect, test } from "vitest";
import game from "./index.js";
import { type HarborState, required } from "./model.js";
import { legalMoves } from "./rules.js";

function fresh(count = 4, shortGame = false) {
  return createMatch(game, {
    seats: Array.from({ length: count }, (_, i) => String(i)),
    seed: 17,
    options: { shortGame },
  });
}
function fixture() {
  const state = fresh();
  state.game.cards = {};
  state.game.deck = [];
  state.game.boxed = [];
  state.game.market = [];
  for (const seat of state.ctx.seats) state.game.hands[seat] = [];
  return state;
}
function put(state: MatchState<HarborState>, into: string[], goods: Array<"fish" | "salt">) {
  return goods.map((good, index) => {
    const id = `fixture-${Object.keys(state.game.cards).length}`;
    state.game.cards[id] = { good, value: ((index % 3) + 1) as 1 | 2 | 3 };
    into.push(id);
    return id;
  });
}
function accepted(state: MatchState<HarborState>, intent: MoveIntent) {
  const result = applyIntent(game, state, state.ctx.currentSeat, intent);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.state;
}
function rejected(state: MatchState<HarborState>, intent: MoveIntent, code: string) {
  const before = JSON.stringify(state);
  expect(applyIntent(game, state, state.ctx.currentSeat, intent)).toMatchObject({
    ok: false,
    code: "INVALID_MOVE",
    gameCode: code,
  });
  expect(JSON.stringify(state)).toBe(before);
}

describe("Harbor Market rules", () => {
  test.each([2, 3, 4])("sets up %i seats with both deck sizes and an initial tide", (count) => {
    for (const short of [false, true]) {
      const state = fresh(count, short);
      const all = [
        ...state.game.deck,
        ...state.game.boxed,
        ...state.game.market,
        ...Object.values(state.game.hands).flat(),
      ];
      expect(all).toHaveLength(45);
      expect(new Set(all).size).toBe(45);
      expect(Object.keys(state.game.cards).sort()).toEqual([...all].sort());
      expect(state.game.boxed).toHaveLength(short ? 15 : 0);
      expect(state.game.deck).toHaveLength((short ? 30 : 45) - 4 * count - 4);
      expect(Object.values(state.game.hands).map((hand) => hand.length)).toEqual(
        Array(count).fill(4),
      );
      expect(state.game.market).toHaveLength(4);
      expect(state.game.tideFace).toBeGreaterThanOrEqual(1);
      expect(state.game.tideFace).toBeLessThanOrEqual(6);
      expect(state.game.tide).not.toBeNull();
      expect(state.ctx).toMatchObject({ currentSeat: "0", phase: "main", turn: 1 });
      for (const good of ["fish", "salt", "silk", "spice", "tea"]) {
        expect(
          Object.values(state.game.cards)
            .filter((card) => card.good === good)
            .map((card) => card.value)
            .sort(),
        ).toEqual([1, 1, 1, 1, 2, 2, 2, 3, 3]);
      }
    }
  });
  test("rejects unsupported seats and options", () => {
    for (const count of [1, 5]) expect(() => fresh(count)).toThrow();
    for (const options of [{ shortGame: "yes" }, { extra: true }, null]) {
      expect(() => createMatch(game, { seats: ["0", "1"], seed: 1, options })).toThrow();
    }
    expect(createMatch(game, { seats: ["0", "1"], seed: 1, options: {} }).game.boxed).toEqual([]);
  });
  test.each(["fish", "salt"] as const)(
    "scores fish 1+2+3 against tide %s and refills left to right",
    (tide) => {
      const state = fixture();
      const cards = put(state, required(state.game.hands["0"]), ["fish", "fish", "fish"]);
      const market = put(state, state.game.market, ["salt", "salt", "salt", "salt"]);
      const deck = put(state, state.game.deck, ["fish", "salt"]);
      state.game.tide = tide;
      const next = accepted(state, { move: "ship", args: { cards } });
      expect(next.game.scores["0"]).toBe(tide === "fish" ? 12 : 6);
      expect(next.game.harbors["0"]).toEqual(cards);
      expect(next.game.hands["0"]).toEqual([]);
      expect(next.game.discard).toEqual(market.slice(0, 1));
      expect(next.game.market).toEqual([...market.slice(1), deck[1]]);
      expect(next.ctx.currentSeat).toBe("1");
    },
  );
  test("swaps in place and consumes exactly one action", () => {
    const state = fresh();
    const hand = required(required(state.game.hands["0"])[1]);
    const market = required(state.game.market[2]);
    const next = accepted(state, { move: "swap", args: { hand, market } });
    expect(required(next.game.hands["0"])[1]).toBe(market);
    expect(next.game.market[2]).toBe(hand);
    expect(next.ctx.turn).toBe(2);
    expect(applyIntent(game, next, "0", { move: "restock" })).toMatchObject({
      code: "NOT_YOUR_TURN",
    });
  });
  test("enforces the hand limit before finishing the turn", () => {
    const state = fixture();
    put(state, required(state.game.hands["0"]), Array(6).fill("fish"));
    put(state, state.game.deck, ["salt", "salt", "fish"]);
    const next = accepted(state, { move: "restock" });
    expect(next.ctx).toMatchObject({ currentSeat: "0", phase: "discard", turn: 1 });
    expect(next.game.tideFace).toBe(state.game.tideFace);
    expect(required(next.game.hands["0"])).toHaveLength(8);
    rejected(next, { move: "discard", args: { cards: [] } }, "WRONG_DISCARD_COUNT");
    rejected(next, { move: "discard", args: { cards: ["missing", "missing"] } }, "NOT_IN_HAND");
    expect(applyIntent(game, next, "0", { move: "restock" })).toMatchObject({
      code: "MOVE_NOT_ALLOWED",
    });
    expect(legalMoves(next.game, next.ctx, "0")).toHaveLength(28);
    const cards = required(next.game.hands["0"]).slice(0, 2);
    const done = accepted(next, { move: "discard", args: { cards } });
    expect(done.ctx).toMatchObject({ phase: "main", currentSeat: "1", turn: 2 });
    expect(done.game.discard).toEqual(cards);
  });
  test("emptying the deck at seat 1 lets seats 2 and 3 finish", () => {
    let state = fixture();
    state.ctx.currentSeat = "1";
    state.ctx.activeSeats = ["1"];
    put(state, state.game.deck, ["salt"]);
    state = accepted(state, { move: "restock" });
    expect(state.game.endTriggered).toBe(true);
    expect(required(state.game.hands["1"])).toHaveLength(1);
    expect(state.result).toBeNull();
    state = accepted(state, { move: "pass" });
    expect(state.ctx.currentSeat).toBe("3");
    expect(state.result).toBeNull();
    const rng = [...state.rng];
    state = accepted(state, { move: "pass" });
    expect(state.result).not.toBeNull();
    expect(state.rng).toEqual(rng);
  });
  test("market refill can trigger the end with a partial market", () => {
    const state = fixture();
    const cards = put(state, required(state.game.hands["0"]), ["fish", "fish"]);
    put(state, state.game.market, ["salt"]);
    const deck = put(state, state.game.deck, ["salt"]);
    const next = accepted(state, { move: "ship", args: { cards } });
    expect(next.game.endTriggered).toBe(true);
    expect(next.game.market).toEqual(deck);
  });
  test("the last seat must discard before the game ends", () => {
    let state = fixture();
    state.ctx.currentSeat = "3";
    state.ctx.activeSeats = ["3"];
    put(state, required(state.game.hands["3"]), Array(6).fill("fish"));
    put(state, state.game.deck, ["salt"]);
    state = accepted(state, { move: "restock" });
    expect(state.result).toBeNull();
    state = accepted(state, {
      move: "discard",
      args: { cards: required(state.game.hands["3"]).slice(0, 1) },
    });
    expect(state.result).not.toBeNull();
    expect(state.ctx.phase).toBe("main");
  });
  test.each([false, true])("breaks ties by harbor size, shared=%s", (shared) => {
    const state = fixture();
    state.ctx.currentSeat = "3";
    state.ctx.activeSeats = ["3"];
    state.game.endTriggered = true;
    state.game.scores = { "0": 10, "1": 10, "2": 9, "3": 0 };
    put(state, required(state.game.harbors["0"]), ["fish", "fish"]);
    put(state, required(state.game.harbors["1"]), shared ? ["salt", "salt"] : ["salt"]);
    expect(accepted(state, { move: "pass" }).result?.winners).toEqual(shared ? ["0", "1"] : ["0"]);
  });
  test("produces every main-phase game rejection and never mutates on failure", () => {
    const state = fixture();
    const cards = put(state, required(state.game.hands["0"]), ["fish", "salt"]);
    const hand = required(cards[0]);
    const market = required(put(state, state.game.market, ["salt"])[0]);
    rejected(state, { move: "swap", args: { hand: "missing", market } }, "NOT_IN_HAND");
    rejected(state, { move: "swap", args: { hand, market: "missing" } }, "NOT_IN_MARKET");
    rejected(state, { move: "ship", args: { cards: [hand] } }, "TOO_FEW_CARDS");
    rejected(state, { move: "ship", args: { cards } }, "MIXED_GOODS");
    rejected(state, { move: "ship", args: { cards: [hand, "missing"] } }, "NOT_IN_HAND");
    rejected(state, { move: "ship", args: { cards: [hand, hand] } }, "NOT_IN_HAND");
    rejected(state, { move: "restock" }, "DECK_EMPTY");
    rejected(state, { move: "pass" }, "PASS_NOT_ALLOWED");
  });
  test("rejects malformed arguments before applying a move", () => {
    for (const intent of [
      { move: "swap", args: { hand: 4, market: "x" } },
      { move: "swap" },
      { move: "ship", args: { cards: [null] } },
      { move: "restock", args: {} },
      { move: "pass", args: false },
      { move: "ship", args: { cards: [], extra: true } },
    ])
      expect(applyIntent(game, fresh(), "0", intent)).toMatchObject({ code: "INVALID_ARGS" });
  });
  test("enumerates all swaps and same-good subsets, only for the active seat", () => {
    const state = fixture();
    put(state, required(state.game.hands["0"]), ["fish", "fish", "fish", "salt"]);
    put(state, state.game.market, ["salt", "salt"]);
    const choices = legalMoves(state.game, state.ctx, "0");
    expect(choices.filter((move) => move.move === "swap")).toHaveLength(8);
    expect(choices.filter((move) => move.move === "ship")).toHaveLength(4);
    for (const intent of choices) expect(applyIntent(game, state, "0", intent).ok).toBe(true);
    expect(legalMoves(state.game, state.ctx, "1")).toEqual([]);
    expect(legalMoves(fixture().game, state.ctx, "0")).toEqual([{ move: "pass" }]);
  });
  test("views expose only own and public cards, including spectator filtering", () => {
    const state = fresh(4, true);
    for (const seat of [...state.ctx.seats, null]) {
      const view = viewFor(game, state, seat);
      const hidden = [
        ...state.game.deck,
        ...state.game.boxed,
        ...Object.entries(state.game.hands)
          .filter(([owner]) => owner !== seat)
          .flatMap(([, hand]) => hand),
      ];
      for (const id of hidden) expect(JSON.stringify(view)).not.toContain(id);
      expect(view.game.hand).toHaveLength(seat === null ? 0 : 4);
      expect(view.game).not.toHaveProperty("cards");
      expect(view).not.toHaveProperty("rng");
    }
  });
});
