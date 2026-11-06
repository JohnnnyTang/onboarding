import { countHidden, invalid, seatsAfter } from "@bgp/rules";
import type {
  Ctx,
  GameResult,
  Invalid,
  Json,
  MoveContext,
  MoveIntent,
  SeatId,
  SetupContext,
} from "@bgp/schema";

// The rules: pure functions of state, with randomness only from `random`. Everything here runs
// on the server (rules host) and, for hot-seat play, in the browser's game worker.

/** Card values, each dealt twice. A card's component definition is `card-<value>`. */
export const VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
const COPIES = 2;
const HAND_SIZE = 3;

/** One card on the table. `id` is opaque (from random.id), so it never reveals the value. */
export type Card = { id: string; value: number };

/** The authoritative state: JSON with integers only. */
export type State = {
  deck: Card[];
  hands: { [seat: SeatId]: Card[] };
  pile: Card[];
  scores: { [seat: SeatId]: number };
};

/** What one seat may know: its own hand, counts of the others, and the public pile. */
export type View = {
  deckCount: number;
  hand: Card[];
  handCounts: { [seat: SeatId]: number };
  pile: Card[];
  scores: { [seat: SeatId]: number };
};

export function defOf(card: Card): string {
  return `card-${card.value}`;
}

function handOf(state: State, seat: SeatId): Card[] {
  const hand = state.hands[seat];
  if (!hand) throw new Error(`Unknown seat ${seat}`);
  return hand;
}

export function setup({ seats, random }: SetupContext): State {
  const values = VALUES.flatMap((value) => Array.from({ length: COPIES }, () => value));
  // Shuffle first, then give out opaque IDs, so an ID says nothing about a card.
  const deck = random.shuffle(values).map((value) => ({ id: random.id(), value }));
  const hands: State["hands"] = {};
  const scores: State["scores"] = {};
  for (const seat of seats) {
    hands[seat] = deck.splice(0, HAND_SIZE);
    scores[seat] = 0;
  }
  return { deck, hands, pile: [], scores };
}

type PlayArgs = { card: string };

/** Untrusted input from a client: narrow it, or say what is wrong. */
function parsePlay(args: Json | undefined): PlayArgs | Invalid {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return invalid("BAD_ARGS", "Choose a card to play.");
  }
  const card = args.card;
  return typeof card === "string" ? { card } : invalid("BAD_ARGS", "Choose a card to play.");
}

/** Play a card on the pile. Beating the top card scores its value. Then draw one. */
function play(state: State, ctx: MoveContext, args: PlayArgs): Invalid | undefined {
  const hand = handOf(state, ctx.seat);
  const index = hand.findIndex((card) => card.id === args.card);
  const [card] = index < 0 ? [] : hand.splice(index, 1);
  if (!card) return invalid("NOT_IN_HAND", "That card is not in your hand.");
  const top = state.pile[state.pile.length - 1];
  if (!top || card.value > top.value) {
    state.scores[ctx.seat] = (state.scores[ctx.seat] ?? 0) + card.value;
  }
  state.pile.push(card);
  const drawn = state.deck.shift();
  if (drawn) hand.push(drawn);
  ctx.events.endTurn();
  return undefined;
}

export const moves = {
  play: { parse: parsePlay, apply: play },
};

/** Skip seats whose hands are empty. */
export function nextSeat(state: State, ctx: Ctx): SeatId {
  return (
    seatsAfter(ctx.seats, ctx.currentSeat).find((seat) => handOf(state, seat).length > 0) ??
    ctx.currentSeat
  );
}

export function endIf(state: State, ctx: Ctx): GameResult | undefined {
  if (ctx.seats.some((seat) => handOf(state, seat).length > 0)) return undefined;
  const best = Math.max(...ctx.seats.map((seat) => state.scores[seat] ?? 0));
  return {
    winners: ctx.seats.filter((seat) => state.scores[seat] === best),
    scores: { ...state.scores },
    reason: "Every card has been played",
  };
}

/** Remove everything this seat may not know: other hands and the deck become counts. */
export function playerView(state: State, ctx: Ctx, seat: SeatId | null): View {
  return {
    deckCount: countHidden(state.deck),
    hand: seat === null ? [] : handOf(state, seat),
    handCounts: Object.fromEntries(
      ctx.seats.map((other) => [other, countHidden(handOf(state, other))]),
    ),
    pile: state.pile,
    scores: state.scores,
  };
}

/** Every move a seat could make now; `bgp validate` plays random games from these. */
export function legalMoves(state: State, ctx: Ctx, seat: SeatId): MoveIntent[] {
  if (seat !== ctx.currentSeat) return [];
  return handOf(state, seat).map((card) => ({ move: "play", args: { card: card.id } }));
}
