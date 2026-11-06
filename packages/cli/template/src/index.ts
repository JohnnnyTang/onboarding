import { defineGame } from "@bgp/rules";
import {
  endIf,
  legalMoves,
  moves,
  nextSeat,
  playerView,
  type State,
  setup,
  type View,
} from "./rules.js";
import { actions, interpret, present } from "./table.js";

// The bundle's default export: one GameDefinition (docs/contracts/rules-api.md).
export default defineGame<State, View>({
  sdk: 1,
  setup,
  moves,
  turn: { next: nextSeat },
  endIf,
  playerView,
  legalMoves,
  present,
  interpret,
  actions,
});
