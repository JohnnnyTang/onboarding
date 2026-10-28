import { createSandboxDefinition, defineGame, invalid } from "@bgp/rules";
import type { ComponentsFile, GameDefinition, ManualOp, SeatId } from "@bgp/schema";
import { JsonSchema } from "@bgp/schema";

export type Board = { cells: (SeatId | null)[] };
const lines = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];
export const ticTacToe = defineGame<Board, Board>({
  sdk: 1,
  setup: () => ({ cells: Array.from({ length: 9 }, () => null) }),
  moves: {
    place: {
      parse(args) {
        return typeof args === "number" && Number.isInteger(args) && args >= 0 && args < 9
          ? args
          : invalid("BAD_CELL", "Choose a cell");
      },
      apply(state, ctx, args) {
        if (typeof args !== "number" || state.cells[args] !== null)
          return invalid("OCCUPIED", "Choose an empty cell");
        state.cells[args] = ctx.seat;
        ctx.events.endTurn();
      },
    },
  },
  endIf(state) {
    for (const line of lines) {
      const first = line[0];
      if (first === undefined) continue;
      const seat = state.cells[first];
      if (seat !== null && seat !== undefined && line.every((cell) => state.cells[cell] === seat))
        return { winners: [seat] };
    }
    return state.cells.every((cell) => cell !== null) ? { winners: [] } : undefined;
  },
  playerView: (state) => state,
  legalMoves: (state, ctx, seat) =>
    ctx.activeSeats.includes(seat)
      ? state.cells.flatMap((cell, index) =>
          cell === null ? [{ move: "place", args: index }] : [],
        )
      : [],
  present: () => ({ table: { size_mm: [300, 300] }, zones: [], items: [] }),
});

export const components: ComponentsFile = {
  schemaVersion: 1,
  defs: [
    { id: "back", kind: "cardBack", image: "assets/back.png" },
    { id: "secret-fish", kind: "card", size_mm: [63, 88], front: "assets/fish.png", back: "back" },
    { id: "secret-tea", kind: "card", size_mm: [63, 88], front: "assets/tea.png", back: "back" },
    { id: "die", kind: "die", sides: 6, size_mm: 15 },
  ],
  zones: [
    {
      id: "deck",
      layout: "stack",
      rect_mm: { x: -100, y: 0, w: 80, h: 100 },
      visibility: "public",
    },
    { id: "market", layout: "row", rect_mm: { x: 0, y: 0, w: 180, h: 100 }, visibility: "public" },
    {
      id: "hand",
      layout: "fan",
      rect_mm: { x: 0, y: 150, w: 180, h: 100 },
      visibility: "owner",
      owner: "each",
    },
    { id: "box", layout: "stack", rect_mm: { x: 200, y: 0, w: 80, h: 100 }, visibility: "public" },
  ],
  setup: {
    instances: [
      { def: "secret-fish", zone: "deck", count: 4, face: "down", shuffle: true },
      { def: "secret-tea", zone: "deck", count: 4, face: "down" },
      { def: "secret-fish", zone: "hand" },
      { def: "secret-tea", zone: "box", face: "down" },
      { def: "die", zone: "market" },
    ],
  },
};

const sandbox = createSandboxDefinition(components);
/** Sandbox has no product legalMoves API: this test adapter enumerates a bounded sample. */
export const sampleSandbox: typeof sandbox = {
  ...sandbox,
  legalMoves(state, ctx, seat) {
    const candidates: ManualOp[] = [
      { op: "shuffle", zone: "deck" },
      { op: "deal", from: "deck", to: ctx.seats.map((s) => `hand:${s}`), count: 1 },
      ...state.items.flatMap((item): ManualOp[] => [
        { op: "move", item: item.id, to: "market", face: "up" },
        { op: "flip", item: item.id },
        { op: "rotate", item: item.id, deg: 90 },
        { op: "roll", item: item.id },
      ]),
    ];
    const parse = sandbox.moves.manual?.parse;
    if (!parse) throw new Error("Missing manual parser");
    return candidates
      .filter((op) => {
        const parsed = parse(JsonSchema.parse(op), { state, ctx, seat });
        return !(typeof parsed === "object" && parsed !== null && "invalid" in parsed);
      })
      .map((args) => ({ move: "manual", args: JsonSchema.parse(args) }));
  },
};

export const counter: GameDefinition<{ n: number }, { n: number }> = {
  sdk: 1,
  setup: () => ({ n: 0 }),
  moves: {
    tick: {
      apply(state) {
        state.n += 1;
      },
    },
  },
  playerView: (state) => state,
  legalMoves: () => [{ move: "tick" }],
  present: () => ({ table: { size_mm: [300, 300] }, zones: [], items: [] }),
};
