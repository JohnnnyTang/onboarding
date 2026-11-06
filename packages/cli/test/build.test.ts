import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildGame, bundleGame } from "../src/build.js";
import { PackageError } from "../src/game-package.js";
import { starter } from "./fixtures.js";

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

async function buildErrors(load: () => ReturnType<Awaited<ReturnType<typeof game>>["load"]>) {
  try {
    await bundleGame(await load());
  } catch (error) {
    if (error instanceof PackageError) return error.errors.map((e) => e.message).join("\n");
    throw error;
  }
  return "";
}

describe("bgp build", () => {
  it("writes one import-free ES module to the manifest's entry", async () => {
    const pkg = await game();
    const built = await buildGame(await pkg.load());
    expect(built.entry).toBe("dist/game.js");
    const source = await readFile(join(pkg.dir, "dist", "game.js"), "utf8");
    expect(source).toBe(built.source);
    expect(source).toMatch(/export \{\s*\w+ as default\s*\};?\s*$/);
    expect(source).not.toMatch(/^import /m);
  });

  it("gives identical bytes for identical sources", async () => {
    const pkg = await game();
    const first = await bundleGame(await pkg.load());
    const second = await bundleGame(await pkg.load());
    expect(second.source).toBe(first.source);
  });

  it("rejects imports other than the SDK", async () => {
    const pkg = await game();
    await pkg.edit(
      "src/rules.ts",
      'import { countHidden, invalid, seatsAfter } from "@bgp/rules";',
      'import { countHidden, invalid, seatsAfter } from "@bgp/rules";\nimport { readFileSync } from "node:fs";\nexport const leak = readFileSync;',
    );
    expect(await buildErrors(pkg.load)).toMatch(
      /Game code may import only @bgp\/rules \(and @bgp\/schema types\), not "node:fs"/,
    );
  });

  it("allows @bgp/schema for types only", async () => {
    const pkg = await game();
    await pkg.edit(
      "src/rules.ts",
      'import { countHidden, invalid, seatsAfter } from "@bgp/rules";',
      'import { countHidden, invalid, seatsAfter } from "@bgp/rules";\nimport { SeatIdSchema } from "@bgp/schema";\nexport const schema = SeatIdSchema;',
    );
    expect(await buildErrors(pkg.load)).toMatch(/Import @bgp\/schema for types only/);
  });

  it("rejects relative imports that leave the package", async () => {
    const pkg = await game();
    await pkg.edit(
      "src/index.ts",
      'import { defineGame } from "@bgp/rules";',
      'import { defineGame } from "@bgp/rules";\nimport "../../outside.js";',
    );
    expect(await buildErrors(pkg.load)).toMatch(/may not import files outside the package/);
  });
});
