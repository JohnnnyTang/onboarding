import { applyIntent, viewFor } from "@bgp/rules";
import { type MatchState, tableSnapshotForSeatSchema } from "@bgp/schema";
import { checkDeterminism, checkLeaks, runMatch } from "@bgp/testing";
import fc from "fast-check";
import { expect, test } from "vitest";
import game, { type HarborState } from "../src/index.js";
import { required } from "../src/model.js";
import { components, oracle } from "./fixtures.js";

declare const console: { info(message: string): void };
declare const process: { env: Record<string, string | undefined> };
const numRuns = Number(process.env.BGP_PROPERTY_RUNS ?? 20);
const seed = fc.integer({ min: 0, max: 0xffff_ffff });
let deterministicGames = 0;
let privateGames = 0;
const match = fc.tuple(seed, seed, fc.integer({ min: 2, max: 4 }), fc.boolean());
function init(seed: number, count: number, shortGame: boolean) {
  return {
    seats: Array.from({ length: count }, (_, i) => String(i)),
    seed,
    options: { shortGame },
  };
}
function conservation(state: MatchState<HarborState>): void {
  const ids = [
    ...state.game.deck,
    ...state.game.boxed,
    ...state.game.market,
    ...state.game.discard,
    ...Object.values(state.game.hands).flat(),
    ...Object.values(state.game.harbors).flat(),
  ];
  expect(ids).toHaveLength(45);
  expect(new Set(ids).size).toBe(45);
  expect([...ids].sort()).toEqual(Object.keys(state.game.cards).sort());
}

test("PROP-DET: complete Harbor Market games replay every state hash", async () => {
  await fc.assert(
    fc.asyncProperty(match, async ([seed, botSeed, count, shortGame]) => {
      const run = await runMatch(game, init(seed, count, shortGame), {
        botSeed,
        maxMoves: 2000,
        onStep: ({ state }) => conservation(state),
      });
      expect(run.stop).toBe("finished");
      await checkDeterminism(game, run);
      deterministicGames += 1;
      if (deterministicGames % 100 === 0)
        console.info(`Verified ${deterministicGames} deterministic games`);
    }),
    { numRuns, seed: 606 },
  );
}, 1800000);

test("UNIT-LEAK: every seat and spectator stays private at every step", async () => {
  await fc.assert(
    fc.asyncProperty(match, async ([seed, botSeed, count, shortGame]) => {
      const run = await runMatch(game, init(seed, count, shortGame), {
        botSeed,
        maxMoves: 2000,
        onStep({ state }) {
          checkLeaks(game, state, { components, oracle });
          const spectator = viewFor(game, state, null);
          const knowledge = oracle(state, null);
          const snapshot = game.present(spectator, { components, seat: null });
          tableSnapshotForSeatSchema({
            components,
            canIdentify: (item) => knowledge.canIdentify(item.id),
            isCard: (item) => knowledge.isCard(item.id),
          }).parse(snapshot);
          const outputs = JSON.stringify([spectator, snapshot]);
          for (const id of knowledge.forbiddenStrings) expect(outputs).not.toContain(id);
          for (const seat of state.ctx.seats) {
            const view = viewFor(game, state, seat);
            const selection = view.game.hand
              .slice(0, state.ctx.phase === "discard" ? view.game.hand.length - 6 : 2)
              .map((card) => card.id);
            for (const action of required(game.actions)(view, { components, seat }, selection)) {
              if (action.enabled) {
                if (!action.intent) throw new Error("Enabled action has no intent");
                expect(applyIntent(game, state, seat, action.intent).ok).toBe(true);
              }
            }
          }
        },
      });
      expect(run.stop).toBe("finished");
      privateGames += 1;
      if (privateGames % 50 === 0) console.info(`Verified ${privateGames} private games`);
    }),
    { numRuns: Math.min(numRuns, 200), seed: 607 },
  );
}, 1800000);
