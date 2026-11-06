import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkUploadedFile } from "@bgp/schema";
import { afterEach, describe, expect, it } from "vitest";
import { loadGamePackage } from "../src/game-package.js";
import { initGame, slugFrom } from "../src/init.js";
import { main } from "../src/main.js";
import { capture } from "./fixtures.js";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function tempRoot(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "bgp-init-"));
  return root;
}

describe("bgp init", () => {
  it("writes a valid package named after the directory", async () => {
    const dir = join(await tempRoot(), "Tide Pool");
    const created = await initGame(dir);
    expect(created).toMatchObject({ id: "tide-pool", name: "Tide Pool" });
    const pkg = await loadGamePackage(dir);
    expect(pkg.manifest).toMatchObject({ id: "tide-pool", name: "Tide Pool", mode: "enforced" });
    expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8")).name).toBe("tide-pool");
    expect(await readFile(join(dir, "README.md"), "utf8")).toMatch(/^# Tide Pool\n/);
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toContain("dist/");
    for (const value of [1, 9]) {
      const path = `assets/card-${value}.png`;
      const bytes = await readFile(join(dir, path));
      expect(checkUploadedFile(path, bytes, pkg.manifest)).toEqual([]);
    }
  });

  it("escapes the name in JSON files", async () => {
    const dir = join(await tempRoot(), "quoted");
    await initGame(dir, { id: "quoted-game", name: 'The "Best" Game' });
    const pkg = await loadGamePackage(dir);
    expect(pkg.manifest.name).toBe('The "Best" Game');
  });

  it("refuses a non-empty directory and invalid ids", async () => {
    const dir = join(await tempRoot(), "taken");
    await mkdir(dir);
    await writeFile(join(dir, "notes.txt"), "mine");
    const output = capture();
    expect(await main(["init", dir], output)).toBe(1);
    expect(output.errors[0]).toMatch(/is not empty/);
    expect(await main(["init", join(dir, "x"), "--id", "X!"], output)).toBe(1);
    expect(output.errors.join("\n")).toMatch(/"X!" is not a valid game id/);
  });

  it("derives slugs", () => {
    expect(slugFrom("My  Great_Game!")).toBe("my-great-game");
    expect(slugFrom("--a--")).toBe("a");
  });
});

describe("main", () => {
  it("prints usage and rejects unknown commands", async () => {
    const output = capture();
    expect(await main(["help"], output)).toBe(0);
    expect(output.lines[0]).toMatch(/^Usage: bgp <command>/);
    expect(await main(["frobnicate"], output)).toBe(2);
    expect(output.errors[0]).toMatch(/Unknown command "frobnicate"/);
    expect(await main(["validate", "--games", "0"], output)).toBe(2);
    expect(output.errors.at(-1)).toMatch(/--games must be an integer of at least 1/);
  });

  it("reports a missing manifest", async () => {
    const output = capture();
    expect(await main(["build", await tempRoot()], output)).toBe(1);
    expect(output.errors.join("\n")).toMatch(/bgp\.json: File not found/);
  });
});
