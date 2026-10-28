import { ComponentsFileSchema, type MatchState, type SeatId } from "@bgp/schema";
import type { LeakKnowledge } from "@bgp/testing";
import declarations from "../components.json" with { type: "json" };
import type { HarborState } from "../src/index.js";

export const components = ComponentsFileSchema.parse(declarations);
export function oracle(state: MatchState<HarborState>, seat: SeatId | null): LeakKnowledge {
  const publicIds = [
    ...state.game.market,
    ...state.game.discard,
    ...Object.values(state.game.harbors).flat(),
  ];
  const known = [...publicIds, ...(seat === null ? [] : (state.game.hands[seat] ?? []))];
  const hidden = [
    ...state.game.deck,
    ...state.game.boxed,
    ...Object.entries(state.game.hands)
      .filter(([owner]) => owner !== seat)
      .flatMap(([, cards]) => cards),
  ];
  const placeholders = Object.entries(state.game.hands)
    .filter(([owner]) => owner !== seat)
    .flatMap(([owner, cards]) => cards.map((_, i) => `x:${owner}:${i}`));
  if (state.game.deck.length > 0) placeholders.push("deck-top");
  return {
    forbiddenStrings: hidden,
    canIdentify: (id) => known.includes(id) || id === "tide-die",
    isOpaqueId: (id) => placeholders.includes(id),
    isCard: (id) => id !== "tide-die",
  };
}
