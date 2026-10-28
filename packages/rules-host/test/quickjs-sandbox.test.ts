import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GameError } from "../src/index.js";
import { QuickJsSandbox } from "../src/quickjs-sandbox.js";
import { GAME_SOURCE, HOSTILE_CASES, hostile, INIT } from "./fixtures.js";

describe("QuickJS rules sandbox", () => {
  it("runs moves, keeps state private, and restores deterministic events", async () => {
    const first = await QuickJsSandbox.load(GAME_SOURCE);
    const second = await QuickJsSandbox.load(GAME_SOURCE);
    try {
      await first.create(INIT);
      const snapshot = await first.exportState();
      const initialHash = await first.hash();
      await second.restore(snapshot, []);
      expect(await second.hash()).toBe(initialHash);
      expect(await first.apply("0", { move: "reject" })).toEqual({
        ok: false,
        code: "INVALID_MOVE",
        gameCode: "NO",
        message: "Try tick",
      });
      expect(await first.hash()).toBe(initialHash);
      const accepted = await first.apply("0", { move: "tick" });
      expect(accepted.ok).toBe(true);
      expect(accepted).not.toHaveProperty("state");
      if (!accepted.ok) throw Error("Expected accepted move");
      await second.restore(snapshot, [accepted.event]);
      expect(await second.hash()).toBe(await first.hash());
      const views = await first.views();
      expect(views["0"]?.game).toEqual(views["1"]?.game);
      expect(JSON.stringify(views)).not.toContain("secret");
      expect(JSON.stringify(views)).not.toContain("rng");
      const canonical = JSON.stringify(await first.exportState(), (_key, value: unknown) => {
        if (value && typeof value === "object" && !Array.isArray(value))
          return Object.fromEntries(
            Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          );
        return value;
      });
      expect(await first.hash()).toBe(createHash("sha256").update(canonical).digest("hex"));
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it.each(HOSTILE_CASES)("INT-ISOLATION: %s is contained", async (_name, body) => {
    const healthy = await QuickJsSandbox.load(GAME_SOURCE);
    const bad = await QuickJsSandbox.load(hostile(body), {
      timeoutMs: 1000,
      memoryLimitBytes: 16 * 1024 * 1024,
    });
    try {
      await healthy.create(INIT);
      await bad.create(INIT);
      const start = performance.now();
      const outcome = await bad
        .apply("0", { move: "tick" })
        .catch(() => ({ ok: false, code: "GAME_ERROR" }));
      expect(outcome).toMatchObject({ ok: false, code: "GAME_ERROR" });
      expect(performance.now() - start).toBeLessThan(1500);
      expect(await healthy.apply("0", { move: "tick" })).toMatchObject({ ok: true });
    } finally {
      bad.dispose();
      healthy.dispose();
    }
  });

  it.each(["setup", "view"] as const)("bounds an infinite loop in %s", async (hook) => {
    const sandbox = await QuickJsSandbox.load(hostile("while (true) {}", hook), {
      timeoutMs: 1000,
    });
    try {
      const call =
        hook === "setup" ? sandbox.create(INIT) : sandbox.create(INIT).then(() => sandbox.views());
      await expect(call).rejects.toBeInstanceOf(GameError);
    } finally {
      sandbox.dispose();
    }
  });

  it("bounds module evaluation, blocks static imports, and sanitizes thrown secrets", async () => {
    await expect(QuickJsSandbox.load("while (true) {}", { timeoutMs: 50 })).rejects.toThrow(
      "Game execution failed",
    );
    await expect(
      QuickJsSandbox.load("import fs from 'node:fs'; export default fs;"),
    ).rejects.toThrow("Game execution failed");
    const bad = await QuickJsSandbox.load(hostile("throw Error(state.secret);"));
    try {
      await bad.create(INIT);
      expect(await bad.apply("0", { move: "tick" })).toEqual({
        ok: false,
        code: "GAME_ERROR",
        message: "Game execution failed",
      });
    } finally {
      bad.dispose();
    }
  });

  it("sanitizes invalid inputs and discards the affected sandbox", async () => {
    const sandbox = await QuickJsSandbox.load(GAME_SOURCE);
    try {
      await sandbox.create(INIT);
      await expect(sandbox.apply("0", { move: "tick", args: 0.5 })).rejects.toMatchObject({
        code: "GAME_ERROR",
        message: "Game execution failed",
      });
      await expect(sandbox.hash()).rejects.toBeInstanceOf(GameError);
    } finally {
      sandbox.dispose();
    }
  });

  it("rejects nonconsecutive restoration events", async () => {
    const sandbox = await QuickJsSandbox.load(GAME_SOURCE);
    try {
      await sandbox.create(INIT);
      const snapshot = await sandbox.exportState();
      await expect(
        sandbox.restore(snapshot, [{ seq: 2, seat: "0", intent: { move: "tick" } }]),
      ).rejects.toThrow("Game execution failed");
    } finally {
      sandbox.dispose();
    }
  });

  it("fails even direct reads of forbidden capabilities", async () => {
    for (const expression of [
      "globalThis.constructor",
      "process",
      "fetch",
      "Date",
      "Math.random",
    ]) {
      const sandbox = await QuickJsSandbox.load(hostile(`${expression};`));
      try {
        await sandbox.create(INIT);
        expect(await sandbox.apply("0", { move: "tick" })).toMatchObject({
          ok: false,
          code: "GAME_ERROR",
        });
      } finally {
        sandbox.dispose();
      }
    }
  });
});
