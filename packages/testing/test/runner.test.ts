import { canonicalJson, createMatch, createRandom, seedRandom } from "@bgp/rules";
import { describe, expect, test } from "vitest";
import { checkDeterminism, randomBot, runMatch } from "../src/index.js";
import { counter, ticTacToe } from "./fixtures.js";

const init = { seats: ["0", "1"], seed: 123, options: {} };

describe("headless match runner and randomBot", () => {
  test("plays to completion with a separate reproducible bot RNG and initial hash", async () => {
    const run = await runMatch(ticTacToe, init);
    expect(run.stop).toBe("finished");
    expect(run.events.length).toBeGreaterThanOrEqual(5);
    expect(run.steps).toHaveLength(run.events.length + 1);
    expect(await runMatch(ticTacToe, init)).toEqual(run);
    await checkDeterminism(ticTacToe, run);
  });

  test("selects each legal move uniformly using the provided random source", () => {
    const state = createMatch(ticTacToe, init);
    const random = createRandom(seedRandom(99));
    const counts = Array.from({ length: 9 }, () => 0);
    for (let draw = 0; draw < 9000; draw += 1) {
      const intent = randomBot(ticTacToe, state, "0", random);
      if (typeof intent?.args !== "number") throw new Error("Missing move");
      counts[intent.args] = (counts[intent.args] ?? 0) + 1;
    }
    expect(counts.every((count) => count > 850 && count < 1150)).toBe(true);
    expect(randomBot(ticTacToe, state, "1", random)).toBeNull();
    expect(() => randomBot(ticTacToe, state, "7", random)).toThrow("Unknown bot seat");
    const { legalMoves: _legalMoves, ...withoutLegalMoves } = ticTacToe;
    expect(() => randomBot(withoutLegalMoves, state, "0", random)).toThrow("requires legalMoves");
  });

  test("reports stalls and limits, rejects invalid budgets and bot moves", async () => {
    expect((await runMatch(counter, init, { maxMoves: 3 })).stop).toBe("move-limit");
    expect((await runMatch(counter, init, { maxMoves: 0 })).steps).toHaveLength(1);
    expect((await runMatch(counter, init, { bot: () => null })).stop).toBe("no-legal-moves");
    for (const maxMoves of [-1, 0.5, Number.NaN]) {
      await expect(runMatch(counter, init, { maxMoves })).rejects.toThrow("maxMoves");
    }
    await expect(runMatch(counter, init, { bot: () => ({ move: "missing" }) })).rejects.toThrow(
      "seq 1: UNKNOWN_MOVE",
    );
    await expect(
      runMatch({ ...counter, legalMoves: () => [{ move: "tick", args: 0.5 }] }, init),
    ).rejects.toThrow();
  });

  test("tries other seats for anySeat moves and detaches bot and observer inputs", async () => {
    const def = {
      ...counter,
      moves: {
        tick: {
          ...counter.moves.tick,
          anySeat: true,
          apply: counter.moves.tick?.apply ?? (() => {}),
        },
      },
    };
    const before = canonicalJson(init);
    const run = await runMatch(def, init, {
      maxMoves: 2,
      bot(_def, state, seat) {
        state.game.n = 999;
        return seat === "1" ? { move: "tick" } : null;
      },
      onStep(step) {
        step.state.game.n = 777;
      },
    });
    expect(run.events.map((event) => event.seat)).toEqual(["1", "1"]);
    expect(run.steps.map((step) => step.state.game.n)).toEqual([0, 1, 2]);
    expect(canonicalJson(init)).toBe(before);
  });
});

test("determinism checker catches setup, intermediate, recorded hash and event divergence", async () => {
  const run = await runMatch(counter, init, { maxMoves: 3 });
  await checkDeterminism(counter, run);
  await expect(checkDeterminism({ ...counter, setup: () => ({ n: 1 }) }, run)).rejects.toThrow(
    "seq 0",
  );
  const converging = {
    ...counter,
    moves: {
      tick: {
        apply(state: { n: number }) {
          state.n = state.n === 0 ? 2 : 3;
        },
      },
    },
  };
  await expect(checkDeterminism(converging, run)).rejects.toThrow("seq 1");
  const changed = structuredClone(run);
  const step = changed.steps[1];
  if (!step) throw new Error("Missing step");
  step.hash = "0".repeat(64);
  await expect(checkDeterminism(counter, changed)).rejects.toThrow("seq 1");
  await expect(checkDeterminism(counter, { ...run, steps: [] })).rejects.toThrow("Incomplete");
  const event = changed.events[0];
  if (!event) throw new Error("Missing event");
  event.seq = 2;
  await expect(checkDeterminism(counter, changed)).rejects.toThrow("Invalid replay sequence");
  event.seq = 1;
  event.intent.move = "missing";
  await expect(checkDeterminism(counter, changed)).rejects.toThrow("Replay rejected");
});
