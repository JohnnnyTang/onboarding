import fc from "fast-check";
import { test } from "vitest";
import { checkDeterminism, runMatch } from "../src/index.js";
import { sampleSandbox, ticTacToe } from "./fixtures.js";

const numRuns = Number(process.env.BGP_PROPERTY_RUNS ?? 20);

test("PROP-DET: seeded tic-tac-toe games reproduce every state hash", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: 0xffff_ffff }),
      fc.integer({ min: 0, max: 0xffff_ffff }),
      async (seed, botSeed) => {
        const run = await runMatch(
          ticTacToe,
          { seats: ["0", "1"], seed, options: {} },
          { botSeed },
        );
        if (run.stop !== "finished") throw new Error("Tic-tac-toe did not finish");
        await checkDeterminism(ticTacToe, run);
      },
    ),
    { numRuns, seed: 505 },
  );
}, 120000);

test("PROP-DET: sample sandbox shuffles, deals and moves reproduce every state hash", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: 0xffff_ffff }),
      fc.integer({ min: 0, max: 0xffff_ffff }),
      async (seed, botSeed) => {
        const run = await runMatch(
          sampleSandbox,
          { seats: ["0", "1", "2"], seed, options: {} },
          { botSeed, maxMoves: 12 },
        );
        await checkDeterminism(sampleSandbox, run);
      },
    ),
    { numRuns, seed: 506 },
  );
}, 120000);
