import { readdir, readFile } from "node:fs/promises";
import { hashState } from "@bgp/rules";
import { expect, test } from "vitest";
import { checkGoldenReplay, parseGoldenReplay } from "../src/index.js";
import { sampleSandbox, ticTacToe } from "./fixtures.js";

// SHA-256 of fixtures.ts when these first recordings were created. The identifier
// is pinned alongside the registry mapping; tests never refresh fixture hashes.
const buildHash = "0af9a42f6c34073d37e74db67432d4af2b4ae95c33c2da1cc695bb6ae5e5ab2a";
const directory = new URL("../golden/", import.meta.url);
async function load(name = "tic-tac-toe.json") {
  return parseGoldenReplay(JSON.parse(await readFile(new URL(name, directory), "utf8")));
}

test("every committed golden fixture replays with its pinned game/build and recorded hashes", async () => {
  const files = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  expect(files.length).toBeGreaterThanOrEqual(2);
  for (const file of files) {
    const golden = await load(file);
    const identity = { game: golden.game, buildHash };
    const state =
      golden.game === "tic-tac-toe"
        ? await checkGoldenReplay(ticTacToe, golden, identity)
        : golden.game === "sample-sandbox"
          ? await checkGoldenReplay(sampleSandbox, golden, identity)
          : (() => {
              throw new Error(`Unregistered golden fixture: ${file}`);
            })();
    expect(await hashState(state)).toBe(golden.expectedHashes[String(golden.events.length)]);
  }
});

test("checks sparse hashes, setup-only recordings and identity before running a fixture", async () => {
  const golden = await load();
  const identity = { game: golden.game, buildHash };
  const setupHash = golden.expectedHashes["0"];
  if (!setupHash) throw new Error("Missing setup hash");
  const initial = await checkGoldenReplay(
    ticTacToe,
    { ...golden, events: [], expectedHashes: { "0": setupHash } },
    identity,
  );
  expect(initial.ctx.moveNumber).toBe(0);
  const finalHash = golden.expectedHashes[String(golden.events.length)];
  if (!finalHash) throw new Error("Missing final hash");
  await checkGoldenReplay(
    ticTacToe,
    { ...golden, expectedHashes: { [golden.events.length]: finalHash } },
    identity,
  );
  await expect(
    checkGoldenReplay(ticTacToe, golden, { ...identity, game: "wrong-game" }),
  ).rejects.toThrow("game/build mismatch");
  await expect(
    checkGoldenReplay(ticTacToe, golden, { ...identity, buildHash: "0".repeat(64) }),
  ).rejects.toThrow("game/build mismatch");
});

test("golden harness rejects changed intermediate hashes and illegal moves", async () => {
  const golden = await load();
  const identity = { game: golden.game, buildHash };
  await expect(
    checkGoldenReplay(
      ticTacToe,
      { ...golden, expectedHashes: { ...golden.expectedHashes, "1": "0".repeat(64) } },
      identity,
    ),
  ).rejects.toThrow("seq 1");
  const event = golden.events[0];
  if (!event) throw new Error("Missing fixture event");
  event.intent = { move: "place", args: 99 };
  await expect(checkGoldenReplay(ticTacToe, golden, identity)).rejects.toThrow(
    "seq 1: INVALID_ARGS",
  );
});

test("golden parser rejects malformed fields, seeds, events, hash keys and integer JSON", async () => {
  const golden = await load();
  for (const malformed of [
    null,
    [],
    {},
    { ...golden, extra: true },
    { ...golden, game: "bad_slug" },
    { ...golden, buildHash: "bad" },
    { ...golden, seed: -1 },
    { ...golden, seed: 0.5 },
    { ...golden, options: { float: 1.2 } },
    { ...golden, seats: ["1", "0"] },
    { ...golden, events: {} },
    { ...golden, events: [{ seq: 2, seat: "0", intent: { move: "place", args: 0 } }] },
    { ...golden, events: [{ seq: 1, seat: "7", intent: { move: "place", args: 0 } }] },
    { ...golden, events: [{ seq: 1, seat: "0", intent: { move: "place", args: 0.5 } }] },
    ...[
      {},
      [],
      null,
      { "01": "0".repeat(64) },
      { "-1": "0".repeat(64) },
      { "99": "0".repeat(64) },
      { "0": "bad" },
    ].map((expectedHashes) => ({ ...golden, expectedHashes })),
  ]) {
    expect(() => parseGoldenReplay(malformed)).toThrow();
  }
  expect(parseGoldenReplay(JSON.parse(JSON.stringify(golden)))).toEqual(golden);
});
