import fc from "fast-check";
import { test } from "vitest";
import { checkLeaks, runMatch } from "../src/index.js";
import { components, sampleSandbox, ticTacToe } from "./fixtures.js";
import { publicBoardOracle, sandboxOracle } from "./leak-oracles.js";

const numRuns = Number(process.env.BGP_PROPERTY_RUNS ?? 20);
test("UNIT-LEAK: every random tic-tac-toe state has valid public views and snapshots", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 0, max: 0xffff_ffff }), async (seed) => {
      await runMatch(
        ticTacToe,
        { seats: ["0", "1"], seed, options: {} },
        {
          onStep: ({ state }) =>
            checkLeaks(ticTacToe, state, { components, oracle: publicBoardOracle }),
        },
      );
    }),
    { numRuns, seed: 507 },
  );
}, 120000);

test("UNIT-LEAK: every random sandbox state hides identities and retires shuffled IDs", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: 0xffff_ffff }),
      fc.integer({ min: 0, max: 0xffff_ffff }),
      async (seed, botSeed) => {
        let previous: string[] = [];
        const retired: string[] = [];
        await runMatch(
          sampleSandbox,
          { seats: ["0", "1", "2"], seed, options: {} },
          {
            botSeed,
            maxMoves: 12,
            onStep({ state }) {
              const ids = state.game.items.map((item) => item.id);
              retired.push(...previous.filter((id) => !ids.includes(id)));
              previous = ids;
              checkLeaks(sampleSandbox, state, {
                components,
                oracle: (state, seat) => {
                  const knowledge = sandboxOracle(state, seat);
                  return {
                    ...knowledge,
                    forbiddenStrings: [...knowledge.forbiddenStrings, ...retired],
                  };
                },
              });
            },
          },
        );
      },
    ),
    { numRuns, seed: 508 },
  );
}, 120000);
