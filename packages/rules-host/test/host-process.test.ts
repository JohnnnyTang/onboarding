import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadBuild } from "../src/build-store.js";
import { HostProcess } from "../src/host-process.js";
import { GAME_SOURCE, INIT } from "./fixtures.js";

describe("restricted host process", () => {
  it("runs the bundled interpreter with only its distribution readable", async () => {
    const host = new HostProcess({ timeoutMs: 1000, memoryLimitBytes: 64 * 1024 * 1024 });
    try {
      expect(
        await host.call({
          op: "load",
          source: GAME_SOURCE,
          timeoutMs: 1000,
          memoryLimitBytes: 64 * 1024 * 1024,
        }),
      ).toBeNull();
      expect(await host.call({ op: "create", init: INIT })).toBeNull();
      expect(await host.call({ op: "apply", seat: "0", intent: { move: "tick" } })).toMatchObject({
        ok: true,
        event: { seq: 1 },
      });
      expect(await host.call({ op: "hash" })).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(await host.call({ op: "views" }))).not.toContain("secret");
    } finally {
      host.dispose();
    }
  });

  it("validates content-addressed builds and suppresses loader errors", async () => {
    const digest = (text: string) => createHash("sha256").update(text).digest("hex");
    const build = {
      entry: "game.js",
      source: GAME_SOURCE,
      files: { "game.js": digest(GAME_SOURCE) },
    };
    const hash = digest(`game.js\t${build.files["game.js"]}\n`);
    expect(await loadBuild({ load: async () => build }, hash)).toBe(GAME_SOURCE);
    await expect(
      loadBuild({ load: async () => ({ ...build, source: "tampered" }) }, hash),
    ).rejects.toThrow("Game execution failed");
    await expect(loadBuild({ load: async () => build }, "a".repeat(64))).rejects.toThrow(
      "Game execution failed",
    );
    await expect(
      loadBuild(
        {
          load: async () => {
            throw Error("private path");
          },
        },
        hash,
      ),
    ).rejects.toThrow("Game execution failed");
  });
});
