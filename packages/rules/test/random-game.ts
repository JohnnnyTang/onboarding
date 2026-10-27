import { defineGame, invalid } from "../src/index.js";

export type RandomGameState = { draws: number[]; deck: number[]; ids: string[] };
export const randomGame = defineGame<RandomGameState, RandomGameState>({
  sdk: 1,
  setup: ({ random }) => ({
    draws: [random.int(-Number.MAX_SAFE_INTEGER, -1)],
    deck: random.shuffle([0, 1, 2, 3, 4, 5]),
    ids: [random.id()],
  }),
  moves: {
    draw: {
      apply(state, ctx) {
        state.draws.push(ctx.random.die(6));
        state.deck = ctx.random.shuffle(state.deck);
        state.ids.push(ctx.random.id());
        ctx.events.endTurn();
      },
    },
    reject: {
      apply(state, ctx) {
        state.draws.push(ctx.random.int(0, 0xffff_ffff));
        ctx.events.endTurn();
        return invalid("TEST_REJECT", "Discard this draft");
      },
    },
  },
  playerView: (state) => state,
  present: () => ({ table: { size_mm: [300, 300] }, zones: [], items: [] }),
});
