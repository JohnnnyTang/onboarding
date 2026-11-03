import { defineGame } from "@bgp/rules";
import { actions, interpret, present } from "./presentation.js";
import { beginTurn, legalMoves, moves, phases, playerView, setup } from "./rules.js";

export type { Card, CardIdentity, Good, HarborState, HarborView } from "./model.js";
export default defineGame({
  sdk: 1,
  setup,
  moves,
  phases,
  startPhase: "main",
  turn: { onBegin: beginTurn },
  playerView,
  legalMoves,
  present,
  interpret,
  actions,
});
