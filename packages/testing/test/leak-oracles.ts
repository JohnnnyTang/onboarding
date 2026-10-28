import type { SandboxState } from "@bgp/schema";
import type { LeakOracle } from "../src/index.js";
import { type Board, components } from "./fixtures.js";

export const publicBoardOracle: LeakOracle<Board> = () => ({
  forbiddenStrings: [],
  canIdentify: () => true,
  isOpaqueId: () => false,
  isCard: () => false,
});

export const sandboxOracle: LeakOracle<SandboxState> = (state, seat) => {
  function visible(id: string) {
    const item = state.game.items.find((item) => item.id === id);
    if (!item) return false;
    if (item.zone.startsWith("hand:")) return item.zone === `hand:${seat}`;
    return item.face === "up";
  }
  const publicDefs = state.game.items.filter((item) => visible(item.id)).map((item) => item.def);
  return {
    // A shared component definition is legal elsewhere if another instance is public.
    // Per-item def checks below still protect hidden instances of that component.
    forbiddenStrings: state.game.items
      .filter((item) => !visible(item.id) && !publicDefs.includes(item.def))
      .map((item) => item.def),
    canIdentify: visible,
    isOpaqueId: (id) =>
      /^i[a-f0-9]{32}$/.test(id) && state.game.items.some((item) => item.id === id),
    isCard: (id) => {
      const item = state.game.items.find((item) => item.id === id);
      return components.defs.some((def) => def.id === item?.def && def.kind === "card");
    },
  };
};
