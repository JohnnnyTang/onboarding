import { createHash } from "node:crypto";
import type { HostBuild, MatchState } from "@bgp/schema";
import { describe, expect, it, vi } from "vitest";
import { GameError, RulesHostClient } from "../src/index.js";
import { QuickJsSandbox } from "../src/quickjs-sandbox.js";
import { GAME_SOURCE, HOSTILE_CASES, hostile, INIT } from "./fixtures.js";

function fixture(sources: string[], options = {}) {
  const builds = new Map<string, HostBuild>();
  const hashes = sources.map((source) => {
    const sha = createHash("sha256").update(source).digest("hex");
    const hash = createHash("sha256").update(`game.js\t${sha}\n`).digest("hex");
    builds.set(hash, { entry: "game.js", files: { "game.js": sha }, source });
    return hash;
  });
  const store = {
    load: vi.fn(async (hash: string) => {
      const build = builds.get(hash);
      if (!build) throw Error("Missing build");
      return build;
    }),
  };
  return { client: new RulesHostClient(store, options), hashes, store };
}

async function add(client: RulesHostClient, id: string, hash: string | undefined) {
  if (!hash) throw Error("Missing build hash");
  await client.load(hash);
  await client.create(id, { ...INIT, buildHash: hash });
}

describe("production rules host client", () => {
  it("pins immutable builds, serializes moves, and returns only per-seat views", async () => {
    const { client, hashes, store } = fixture([GAME_SOURCE]);
    const direct = await QuickJsSandbox.load(GAME_SOURCE);
    try {
      await add(client, "one", hashes[0]);
      await direct.create(INIT);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => client.apply("one", "0", { move: "tick" })),
      );
      expect(results.map((result) => (result.ok ? result.event.seq : 0))).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
      ]);
      for (let index = 0; index < 10; index++) await direct.apply("0", { move: "tick" });
      expect(await client.hash("one")).toBe(await direct.hash());
      expect(await client.views("one")).toEqual(await direct.views());
      expect(JSON.stringify(await client.views("one"))).not.toMatch(/secret|rng/);
      expect(results[0]).not.toHaveProperty("state");
      const before = await client.hash("one");
      expect(await client.apply("one", "0", { move: "reject" })).toMatchObject({
        code: "INVALID_MOVE",
        message: "Try tick",
      });
      expect(await client.hash("one")).toBe(before);
      await client.load(hashes[0] ?? "");
      expect(store.load).toHaveBeenCalledTimes(1);
      await expect(
        client.create("one", { ...INIT, buildHash: hashes[0] ?? "" }),
      ).rejects.toBeInstanceOf(GameError);
    } finally {
      client.close();
      direct.dispose();
    }
  });

  it.each(HOSTILE_CASES)("INT-ISOLATION through production IPC: %s", async (_name, body) => {
    const { client, hashes } = fixture([GAME_SOURCE, hostile(body)], {
      memoryLimitBytes: 16 * 1024 * 1024,
    });
    try {
      await add(client, "healthy", hashes[0]);
      await add(client, "bad", hashes[1]);
      const before = await client.hash("bad");
      const start = performance.now();
      const failure = client.apply("bad", "0", { move: "tick" }).catch((error: unknown) => {
        expect(error).toBeInstanceOf(GameError);
        return { ok: false, code: "GAME_ERROR", message: "Game execution failed" };
      });
      // The other match must progress while the hostile call is still running.
      expect(await client.apply("healthy", "0", { move: "tick" })).toMatchObject({ ok: true });
      if (_name === "infinite loop") expect(performance.now() - start).toBeLessThan(500);
      expect(await failure).toMatchObject({
        ok: false,
        code: "GAME_ERROR",
        message: "Game execution failed",
      });
      expect(performance.now() - start).toBeLessThan(1500);
      expect(await client.hash("bad")).toBe(before);
      expect(await client.apply("healthy", "0", { move: "tick" })).toMatchObject({ ok: true });
    } finally {
      client.close();
    }
  });

  it("INT-RECOVERY: kills a busy host, restores snapshot plus events and continues with identical hashes", async () => {
    const source = GAME_SOURCE.replace(
      "moves: {",
      "moves: { hang: { anySeat: true, apply() { while (true) {} } },",
    );
    const { client, hashes } = fixture([source]);
    const direct = await QuickJsSandbox.load(source);
    try {
      await add(client, "recover", hashes[0]);
      await direct.create(INIT);
      const snapshot = await client.exportState("recover");
      const first = await client.apply("recover", "0", { move: "tick" });
      if (!first.ok) throw Error("Expected accepted move");
      await direct.apply("0", { move: "tick" });
      await client.restore("recover", snapshot, [first.event]);
      await client.apply("recover", "1", { move: "tick" });
      await direct.apply("1", { move: "tick" });
      const hash = await client.hash("recover");
      const oldPid = client.processId("recover");
      if (!oldPid) throw Error("Missing host process");
      const pending = client.apply("recover", "0", { move: "hang" });
      const kill = setTimeout(() => process.kill(oldPid, "SIGKILL"), 100);
      try {
        await expect(pending).rejects.toBeInstanceOf(GameError);
      } finally {
        clearTimeout(kill);
      }
      expect(await client.hash("recover")).toBe(hash);
      expect(client.processId("recover")).not.toBe(oldPid);
      expect(await client.views("recover")).toEqual(await direct.views());
      const intent = { move: "tick" };
      expect(await client.apply("recover", "1", intent)).toEqual(await direct.apply("1", intent));
      expect(await client.hash("recover")).toBe(await direct.hash());
    } finally {
      client.close();
      direct.dispose();
    }
  });

  it("recovers an idle crash automatically and keeps detached recovery inputs", async () => {
    const { client, hashes } = fixture([GAME_SOURCE]);
    try {
      await add(client, "idle", hashes[0]);
      const checkpoint = await client.exportState("idle");
      const first = await client.apply("idle", "0", { move: "tick" });
      if (!first.ok) throw Error("Expected move");
      const event = structuredClone(first.event);
      await client.restore("idle", checkpoint, [event]);
      const before = await client.hash("idle");
      checkpoint.rng[0] = 0;
      event.intent.move = "hang";
      first.event.intent.move = "also-mutated";
      const pid = client.processId("idle");
      if (!pid) throw Error("Missing pid");
      process.kill(pid, "SIGKILL");
      await vi.waitFor(() => expect(client.processId("idle")).toBeUndefined());
      expect(await client.hash("idle")).toBe(before);
    } finally {
      client.close();
    }
  });

  it.each(["setup", "view"] as const)(
    "bounds a hostile %s hook through the watchdog",
    async (hook) => {
      const { client, hashes } = fixture([hostile("while (true) {}", hook)]);
      try {
        const start = performance.now();
        if (hook === "setup")
          await expect(add(client, "bad", hashes[0])).rejects.toBeInstanceOf(GameError);
        else {
          await add(client, "bad", hashes[0]);
          await expect(client.views("bad")).rejects.toBeInstanceOf(GameError);
        }
        expect(performance.now() - start).toBeLessThan(1500);
      } finally {
        client.close();
      }
    },
  );

  it("bounds module evaluation and rejects malformed definitions", async () => {
    const { client, hashes } = fixture(["while (true) {}", "export default {};"]);
    try {
      const start = performance.now();
      await expect(add(client, "bad", hashes[0])).rejects.toBeInstanceOf(GameError);
      expect(performance.now() - start).toBeLessThan(1500);
      await expect(add(client, "malformed", hashes[1])).rejects.toBeInstanceOf(GameError);
    } finally {
      client.close();
    }
  });

  it("disposal cancels pending work and close prevents new work", async () => {
    const { client, hashes } = fixture([hostile("while (true) {}")]);
    try {
      await add(client, "bad", hashes[0]);
      const pending = client.apply("bad", "0", { move: "tick" });
      const queued = client.hash("bad");
      const dispose = setTimeout(() => client.dispose("bad"), 50);
      try {
        await expect(pending).rejects.toBeInstanceOf(GameError);
        await expect(queued).rejects.toBeInstanceOf(GameError);
      } finally {
        clearTimeout(dispose);
      }
      client.dispose("bad");
      client.close();
      await expect(client.load(hashes[0] ?? "")).rejects.toBeInstanceOf(GameError);
      await expect(client.hash("bad")).rejects.toBeInstanceOf(GameError);
    } finally {
      client.close();
    }
  });

  it("invalid or out-of-order restore inputs cannot corrupt the recovery journal", async () => {
    const { client, hashes } = fixture([GAME_SOURCE]);
    try {
      await add(client, "safe", hashes[0]);
      const checkpoint = await client.exportState("safe");
      const before = await client.hash("safe");
      await expect(
        client.restore("safe", { ...checkpoint, game: 0.5 } as MatchState, []),
      ).rejects.toBeInstanceOf(GameError);
      await expect(
        client.restore("safe", checkpoint, [{ seq: 2, seat: "0", intent: { move: "tick" } }]),
      ).rejects.toBeInstanceOf(GameError);
      expect(await client.hash("safe")).toBe(before);
    } finally {
      client.close();
    }
  });
});
