import type { GameDefinition, Json, SeatId } from "@bgp/schema";
import { defineGame, invalid } from "../src/index.js";

export type Board = { cells: (SeatId | null)[] };
const LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

export const ticTacToe: GameDefinition<Board, Board> = defineGame<Board, Board>({
  sdk: 1,
  setup: () => ({ cells: Array.from({ length: 9 }, () => null) }),
  moves: {
    place: {
      parse(args) {
        return typeof args === "number" && Number.isInteger(args) && args >= 0 && args < 9
          ? args
          : invalid("BAD_CELL", "Choose a cell from 0 to 8");
      },
      apply(state, ctx, args: Json) {
        if (typeof args !== "number") return invalid("BAD_CELL", "Choose a cell");
        if (state.cells[args] !== null) return invalid("OCCUPIED", "Cell is occupied");
        state.cells[args] = ctx.seat;
        ctx.events.endTurn();
      },
    },
  },
  endIf(state) {
    for (const [a, b, c] of LINES) {
      if (a === undefined || b === undefined || c === undefined) continue;
      const seat = state.cells[a];
      if (
        seat !== null &&
        seat !== undefined &&
        seat === state.cells[b] &&
        seat === state.cells[c]
      ) {
        return { winners: [seat], reason: "Three in a row" };
      }
    }
    return state.cells.every((cell) => cell !== null) ? { winners: [], reason: "Draw" } : undefined;
  },
  playerView: (state) => state,
  present: () => ({ table: { size_mm: [300, 300] }, zones: [], items: [] }),
});
