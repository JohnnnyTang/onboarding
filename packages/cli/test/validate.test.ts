import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadGamePackage } from "../src/game-package.js";
import { chunkGames, validateGame } from "../src/validate.js";
import { QUICK, starter } from "./fixtures.js";

// T19 done-when: `bgp validate` passes the starter game and catches a planted leak and a
// planted Math.random. Each test edits a fresh copy of the template.

const RULES = "src/rules.ts";
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function game() {
  const pkg = await starter();
  cleanup = pkg.cleanup;
  return pkg;
}

describe("validateGame", () => {
  it("passes the starter game", async () => {
    const pkg = await game();
    const result = await validateGame(await pkg.load(), QUICK);
    expect(result.packageErrors).toEqual([]);
    expect(result.gameErrors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.runs.map((run) => run.index)).toEqual([0, 1, 2, 3]);
    expect(result.runs.every((run) => run.stop === "finished")).toBe(true);
    // Seat counts cycle through players.min..max.
    expect(result.runs.map((run) => run.seats)).toEqual([2, 3, 4, 2]);
  });

  it("catches a view that leaks another seat's hand", async () => {
    const pkg = await game();
    await pkg.edit(
      RULES,
      "hand: seat === null ? [] : handOf(state, seat),",
      'hand: handOf(state, ctx.seats[0] ?? "0"),',
    );
    const result = await validateGame(await pkg.load(), QUICK);
    expect(result.ok).toBe(false);
    expect(result.gameErrors.join("\n")).toMatch(
      /view carries instance "i[0-9a-f]+" with all its data/,
    );
  });

  it("catches a view that leaks the deck", async () => {
    const pkg = await game();
    await pkg.edit(RULES, "deckCount: countHidden(state.deck),", "deckCount: 0, deck: state.deck,");
    const result = await validateGame(await pkg.load(), QUICK);
    expect(result.ok).toBe(false);
    expect(result.gameErrors.join("\n")).toMatch(/view carries instance/);
  });

  it("catches Math.random", async () => {
    const pkg = await game();
    await pkg.edit(RULES, "random.shuffle(values)", "[...values].sort(() => Math.random() - 0.5)");
    const result = await validateGame(await pkg.load(), QUICK);
    expect(result.ok).toBe(false);
    expect(result.gameErrors[0]).toBe(
      "Game code used Math.random, which games may not use: use ctx.random (or random in setup) instead",
    );
  });

  it("catches Date in a move", async () => {
    const pkg = await game();
    await pkg.edit(RULES, "state.pile.push(card);", "state.pile.push(card);\n  Date.now();");
    const result = await validateGame(await pkg.load(), QUICK);
    expect(result.ok).toBe(false);
    expect(result.gameErrors[0]).toMatch(/^Game code used Date/);
    expect(result.gameErrors.join("\n")).toMatch(/failed with GAME_ERROR/);
  });

  it("stops a move that never returns", async () => {
    const pkg = await game();
    await pkg.edit(RULES, "state.pile.push(card);", "while (card) state.pile.length;");
    const result = await validateGame(await pkg.load(), { ...QUICK, stepTimeoutMs: 1500 });
    expect(result.ok).toBe(false);
    expect(result.gameErrors[0]).toMatch(/did not return within 1.5 s/);
  });

  it("reports nondeterminism the traps cannot see", async () => {
    const pkg = await game();
    // A counter outside the state: replays from the same seed and moves diverge.
    await pkg.edit(
      RULES,
      "state.pile.push(card);",
      "state.pile.push(card);\n  calls += 1;\n  if (calls % 7 === 0) state.scores[ctx.seat] = 99;",
    );
    await pkg.edit(RULES, "const COPIES = 2;", "const COPIES = 2;\nlet calls = 0;");
    const result = await validateGame(await pkg.load(), QUICK);
    expect(result.ok).toBe(false);
    expect(result.gameErrors.join("\n")).toMatch(/not deterministic/);
  });

  it("reports package errors with their paths", async () => {
    const pkg = await game();
    await pkg.edit("components.json", '"assets/card-9.png"', '"assets/card-10.png"');
    const result = await validateGame(await pkg.load(), QUICK);
    expect(result.ok).toBe(false);
    expect(result.packageErrors).toContainEqual({
      path: "defs.9.front",
      message: "Missing asset assets/card-10.png",
    });
  });
});

describe("chunkGames", () => {
  it("splits games into contiguous chunks", () => {
    expect(chunkGames(5, 2)).toEqual([
      [0, 1, 2],
      [3, 4],
    ]);
    expect(chunkGames(2, 4)).toEqual([[0], [1]]);
    expect(chunkGames(3, 1)).toEqual([[0, 1, 2]]);
  });
});

describe("Harbor Market", () => {
  it("passes validation", async () => {
    const harbor = fileURLToPath(new URL("../../../games/harbor-market", import.meta.url));
    const result = await validateGame(await loadGamePackage(harbor), { ...QUICK, games: 2 });
    expect(result.gameErrors).toEqual([]);
    expect(result.packageErrors).toEqual([]);
    expect(result.runs).toHaveLength(2);
  });
});
