import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGamePackage } from "../src/game-package.js";
import { initGame } from "../src/init.js";
import type { Output } from "../src/main.js";

/** A fresh starter package in a temporary directory. */
export async function starter(id = "test-game") {
  const root = await mkdtemp(join(tmpdir(), "bgp-cli-"));
  const dir = join(root, id);
  await initGame(dir);
  return {
    dir,
    load: () => loadGamePackage(dir),
    /** Replaces exactly one occurrence of `from` in a package file. */
    async edit(file: string, from: string, to: string) {
      const path = join(dir, file);
      const text = await readFile(path, "utf8");
      if (text.split(from).length !== 2) throw new Error(`Expected one "${from}" in ${file}`);
      await writeFile(path, text.replace(from, to));
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export function capture(): Output & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (line) => lines.push(line), err: (line) => errors.push(line) };
}

/** Fast settings for tests: a few games on two workers. */
export const QUICK = { games: 4, firstSeed: 1, maxMoves: 200, stepTimeoutMs: 5000, workers: 2 };
