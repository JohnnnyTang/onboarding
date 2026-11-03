import type { SeatId } from "@bgp/schema";

export const GOODS = ["fish", "salt", "silk", "spice", "tea"] as const;
export type Good = (typeof GOODS)[number];
export type CardIdentity = { good: Good; value: 1 | 2 | 3 };
export type Card = CardIdentity & { id: string };
export type HarborState = {
  cards: Record<string, CardIdentity>;
  deck: string[];
  boxed: string[];
  market: string[];
  discard: string[];
  hands: Record<SeatId, string[]>;
  harbors: Record<SeatId, string[]>;
  scores: Record<SeatId, number>;
  tide: Good | "calm" | null;
  tideFace: number | null;
  endTriggered: boolean;
};
export type HarborView = {
  hand: Card[];
  handCounts: Record<SeatId, number>;
  deckCount: number;
  market: Card[];
  discard: Card[];
  harbors: Record<SeatId, Card[]>;
  scores: Record<SeatId, number>;
  tide: Good | "calm" | null;
  tideFace: number | null;
  endTriggered: boolean;
};

export function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Invalid Harbor Market state");
  return value;
}

export function combinations<T>(items: readonly T[], count: number): T[][] {
  if (count === 0) return [[]];
  if (count < 0 || count > items.length) return [];
  const result: T[][] = [];
  for (let i = 0; i <= items.length - count; i += 1) {
    for (const rest of combinations(items.slice(i + 1), count - 1)) {
      result.push([required(items[i]), ...rest]);
    }
  }
  return result;
}
