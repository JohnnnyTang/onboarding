import { invalid } from "@bgp/rules";
import type {
  Ctx,
  GameResult,
  Json,
  MoveContext,
  MoveDefinition,
  MoveIntent,
  SeatId,
  SetupContext,
} from "@bgp/schema";
import {
  type Card,
  combinations,
  GOODS,
  type HarborState,
  type HarborView,
  required,
} from "./model.js";

type SwapArgs = { hand: string; market: string };
type CardsArgs = { cards: string[] };
function objectArgs(args: Json | undefined): Record<string, Json> {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Expected object");
  return args;
}
function swapArgs(args: Json | undefined): SwapArgs {
  const value = objectArgs(args);
  if (
    Object.keys(value).length !== 2 ||
    typeof value.hand !== "string" ||
    typeof value.market !== "string"
  )
    throw new Error("Invalid swap");
  return { hand: value.hand, market: value.market };
}
function cardsArgs(args: Json | undefined): CardsArgs {
  const value = objectArgs(args);
  if (
    Object.keys(value).length !== 1 ||
    !Array.isArray(value.cards) ||
    !value.cards.every((id) => typeof id === "string")
  )
    throw new Error("Invalid cards");
  return { cards: value.cards };
}
function noArgs(args: Json | undefined): null {
  if (args !== undefined && args !== null) throw new Error("Unexpected arguments");
  return null;
}
function distinct(ids: string[]): boolean {
  return ids.every((id, index) => ids.indexOf(id) === index);
}
function draw(state: HarborState, destination: string[]): void {
  const id = state.deck.pop();
  if (id !== undefined) destination.push(id);
}
export function setup(init: SetupContext): HarborState {
  if (
    init.seats.length < 2 ||
    init.seats.length > 4 ||
    init.seats.some((seat, i) => seat !== String(i))
  )
    throw new Error("Expected 2–4 seats");
  const options = objectArgs(init.options);
  if (
    Object.keys(options).some((key) => key !== "shortGame") ||
    (options.shortGame !== undefined && typeof options.shortGame !== "boolean")
  )
    throw new Error("Invalid options");
  const state: HarborState = {
    cards: {},
    deck: [],
    boxed: [],
    market: [],
    discard: [],
    hands: {},
    harbors: {},
    scores: {},
    tide: null,
    tideFace: null,
    endTriggered: false,
  };
  for (const good of GOODS) {
    for (const value of [1, 1, 1, 1, 2, 2, 2, 3, 3] as const) {
      const id = init.random.id();
      state.cards[id] = { good, value };
      state.deck.push(id);
    }
  }
  state.deck = init.random.shuffle(state.deck);
  if (options.shortGame === true) {
    for (let i = 0; i < 15; i += 1) draw(state, state.boxed);
  }
  for (const seat of init.seats) {
    state.hands[seat] = [];
    state.harbors[seat] = [];
    state.scores[seat] = 0;
  }
  for (let round = 0; round < 4; round += 1) {
    for (const seat of init.seats) draw(state, required(state.hands[seat]));
  }
  for (let i = 0; i < 4; i += 1) draw(state, state.market);
  return state;
}
export function beginTurn(state: HarborState, ctx: MoveContext): void {
  state.tideFace = ctx.random.die(6);
  state.tide = state.tideFace === 6 ? "calm" : required(GOODS[state.tideFace - 1]);
}
function resultFor(state: HarborState, seats: SeatId[]): GameResult {
  let winners: SeatId[] = [];
  let bestScore = -1;
  let bestCount = -1;
  for (const seat of seats) {
    const score = required(state.scores[seat]);
    const count = required(state.harbors[seat]).length;
    if (score > bestScore || (score === bestScore && count > bestCount)) {
      winners = [seat];
      bestScore = score;
      bestCount = count;
    } else if (score === bestScore && count === bestCount) winners.push(seat);
  }
  return {
    winners,
    scores: { ...state.scores },
    reason: "The deck is empty and the round is complete.",
  };
}
function finishTurn(state: HarborState, ctx: MoveContext): void {
  if (ctx.phase === "discard") ctx.events.setPhase("main");
  if (state.endTriggered && ctx.currentSeat === ctx.seats[ctx.seats.length - 1]) {
    ctx.events.endGame(resultFor(state, ctx.seats));
  } else ctx.events.endTurn();
}
function finishAction(state: HarborState, ctx: MoveContext): void {
  if (state.deck.length === 0) state.endTriggered = true;
  if (required(state.hands[ctx.seat]).length > 6) ctx.events.setPhase("discard");
  else finishTurn(state, ctx);
}
function canShip(state: HarborState, hand: string[]): boolean {
  return GOODS.some(
    (good) => hand.filter((id) => required(state.cards[id]).good === good).length >= 2,
  );
}
export const moves: Record<string, MoveDefinition<HarborState>> = {
  swap: {
    parse: swapArgs,
    apply(state, ctx, args) {
      const { hand: handId, market: marketId } = args as SwapArgs;
      const hand = required(state.hands[ctx.seat]);
      const handIndex = hand.indexOf(handId);
      if (handIndex < 0) return invalid("NOT_IN_HAND", "Choose a card in your hand.");
      const marketIndex = state.market.indexOf(marketId);
      if (marketIndex < 0) return invalid("NOT_IN_MARKET", "Choose a card in the market.");
      hand[handIndex] = marketId;
      state.market[marketIndex] = handId;
      finishAction(state, ctx);
    },
  },
  ship: {
    parse: cardsArgs,
    apply(state, ctx, args) {
      const { cards } = args as CardsArgs;
      if (cards.length < 2) return invalid("TOO_FEW_CARDS", "Select at least two cards to ship.");
      const hand = required(state.hands[ctx.seat]);
      if (!distinct(cards) || cards.some((id) => !hand.includes(id)))
        return invalid("NOT_IN_HAND", "Choose distinct cards in your hand.");
      const good = required(state.cards[required(cards[0])]).good;
      if (cards.some((id) => required(state.cards[id]).good !== good))
        return invalid("MIXED_GOODS", "Ship cards of one good.");
      const score = cards.reduce(
        (sum, id) => sum + required(state.cards[id]).value + (state.tide === good ? 2 : 0),
        0,
      );
      state.scores[ctx.seat] = required(state.scores[ctx.seat]) + score;
      state.hands[ctx.seat] = hand.filter((id) => !cards.includes(id));
      required(state.harbors[ctx.seat]).push(...cards);
      const discarded = state.market.shift();
      if (discarded !== undefined) state.discard.push(discarded);
      while (state.market.length < 4 && state.deck.length > 0) draw(state, state.market);
      finishAction(state, ctx);
    },
  },
  restock: {
    parse: noArgs,
    apply(state, ctx) {
      if (state.deck.length === 0) return invalid("DECK_EMPTY", "The deck is empty.");
      const hand = required(state.hands[ctx.seat]);
      draw(state, hand);
      draw(state, hand);
      finishAction(state, ctx);
    },
  },
  pass: {
    parse: noArgs,
    apply(state, ctx) {
      const hand = required(state.hands[ctx.seat]);
      if (
        state.deck.length > 0 ||
        (hand.length > 0 && state.market.length > 0) ||
        canShip(state, hand)
      )
        return invalid("PASS_NOT_ALLOWED", "Another move is available.");
      finishAction(state, ctx);
    },
  },
  discard: {
    parse: cardsArgs,
    apply(state, ctx, args) {
      const { cards } = args as CardsArgs;
      const hand = required(state.hands[ctx.seat]);
      if (cards.length !== hand.length - 6)
        return invalid("WRONG_DISCARD_COUNT", "Discard exactly enough cards to keep six.");
      if (!distinct(cards) || cards.some((id) => !hand.includes(id)))
        return invalid("NOT_IN_HAND", "Choose distinct cards in your hand.");
      state.hands[ctx.seat] = hand.filter((id) => !cards.includes(id));
      state.discard.push(...cards);
      finishTurn(state, ctx);
    },
  },
};
export const phases = {
  main: { moves: ["swap", "ship", "restock", "pass"] },
  discard: { moves: ["discard"] },
};
export function legalMoves(state: HarborState, ctx: Ctx, seat: SeatId): MoveIntent[] {
  if (seat !== ctx.currentSeat || !ctx.activeSeats.includes(seat)) return [];
  const hand = required(state.hands[seat]);
  if (ctx.phase === "discard")
    return combinations(hand, hand.length - 6).map((cards) => ({
      move: "discard",
      args: { cards },
    }));
  if (ctx.phase !== "main") return [];
  const result: MoveIntent[] = [];
  for (const handId of hand) {
    for (const market of state.market)
      result.push({ move: "swap", args: { hand: handId, market } });
  }
  for (const good of GOODS) {
    const matching = hand.filter((id) => required(state.cards[id]).good === good);
    for (let count = 2; count <= matching.length; count += 1) {
      for (const cards of combinations(matching, count))
        result.push({ move: "ship", args: { cards } });
    }
  }
  if (state.deck.length > 0) result.push({ move: "restock" });
  if (result.length === 0) result.push({ move: "pass" });
  return result;
}
export function playerView(state: HarborState, ctx: Ctx, seat: SeatId | null): HarborView {
  const visibleCards = (ids: string[]): Card[] =>
    ids.map((id) => ({ id, ...required(state.cards[id]) }));
  return {
    hand: seat === null ? [] : visibleCards(required(state.hands[seat])),
    handCounts: Object.fromEntries(ctx.seats.map((id) => [id, required(state.hands[id]).length])),
    deckCount: state.deck.length,
    market: visibleCards(state.market),
    discard: visibleCards(state.discard),
    harbors: Object.fromEntries(
      ctx.seats.map((id) => [id, visibleCards(required(state.harbors[id]))]),
    ),
    scores: { ...state.scores },
    tide: state.tide,
    tideFace: state.tideFace,
    endTriggered: state.endTriggered,
  };
}
