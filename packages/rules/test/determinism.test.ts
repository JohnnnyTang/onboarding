import { expect, test } from "vitest";
import {
  type AcceptedEvent,
  applyIntent,
  canonicalJson,
  createMatch,
  createRandom,
  hashState,
  replay,
  seedRandom,
} from "../src/index.js";
import { randomGame } from "./random-game.js";
import { ticTacToe } from "./tic-tac-toe.js";

declare const process: { env: Record<string, string | undefined> };

test("seed expansion and mixed Random calls retain their compatibility vector", () => {
  const rng = seedRandom(0);
  expect(rng).toEqual([2124676951, 774849047, 1908252211, 13]);
  const random = createRandom(rng);
  expect([
    random.int(-100, 100),
    random.die(6),
    random.pick(["a", "b"]),
    random.shuffle([1, 2, 3, 4]),
    random.id(),
    rng,
  ]).toEqual([
    9,
    2,
    "b",
    [4, 3, 1, 2],
    "idf3a947a593044012be202fff87f0f65",
    [141839075, 3876792574, 2321462981, 23],
  ]);
});

test("die and shuffle distribution sanity (nightly draw count is configurable)", () => {
  const draws = Number(process.env.BGP_PRNG_DRAWS ?? 6000);
  const random = createRandom(seedRandom(123));
  const dice = Array.from({ length: 6 }, () => 0);
  const positions = Array.from({ length: 6 }, () => 0);
  for (let index = 0; index < draws; index += 1) {
    const die = random.die(6) - 1;
    dice[die] = (dice[die] ?? 0) + 1;
    const position = random.shuffle([0, 1, 2, 3, 4, 5]).indexOf(0);
    positions[position] = (positions[position] ?? 0) + 1;
  }
  const expected = draws / 6;
  for (const counts of [dice, positions]) {
    const chiSquared = counts.reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0);
    expect(chiSquared).toBeLessThan(30); // df=5, deliberately conservative fixed-seed sanity bound.
  }
});

test("seeded state transitions and random tic-tac-toe games replay at every step", async () => {
  const runs = Number(process.env.BGP_PROPERTY_RUNS ?? 20);
  for (let seed = 0; seed < runs; seed += 1) {
    const init = { seats: ["0", "1"], seed, options: {} };
    let state = createMatch(ticTacToe, init);
    const random = createRandom(seedRandom(seed));
    const events: AcceptedEvent[] = [];
    while (state.result === null) {
      const available = state.game.cells.flatMap((cell, index) => (cell === null ? [index] : []));
      const result = applyIntent(ticTacToe, state, state.ctx.currentSeat, {
        move: "place",
        args: random.pick(available),
      });
      if (!result.ok) throw new Error(result.code);
      events.push(result.event);
      state = result.state;
      expect(await hashState(replay(ticTacToe, init, events))).toBe(await hashState(state));
    }
    let randomState = createMatch(randomGame, init);
    const randomEvents: AcceptedEvent[] = [];
    for (let step = 0; step < 6; step += 1) {
      const before = canonicalJson(randomState);
      expect(
        applyIntent(randomGame, randomState, randomState.ctx.currentSeat, { move: "reject" }),
      ).toMatchObject({ ok: false, code: "INVALID_MOVE" });
      expect(canonicalJson(randomState)).toBe(before);
      const result = applyIntent(randomGame, randomState, randomState.ctx.currentSeat, {
        move: "draw",
      });
      if (!result.ok) throw new Error(result.code);
      randomEvents.push(result.event);
      randomState = result.state;
      expect(await hashState(replay(randomGame, init, randomEvents))).toBe(
        await hashState(randomState),
      );
    }
  }
}, 120000);
