import { createHash } from "node:crypto";
import { createSandboxDefinition, hashState, replay } from "@bgp/rules";
import type { ClientView, ComponentsFile, HostBuild } from "@bgp/schema";
import { describe, expect, it } from "vitest";
import { loadBuild } from "../src/build-store.js";
import { GameError, RulesHostClient } from "../src/index.js";
import { QuickJsSandbox } from "../src/quickjs-sandbox.js";

// T17 (Q-017): sandbox versions run the runtime's own sandbox definition in QuickJS.

const COMPONENTS: ComponentsFile = {
  schemaVersion: 1,
  defs: [
    { id: "back", kind: "cardBack", image: "assets/back.png" },
    { id: "gold", kind: "card", size_mm: [63, 88], front: "assets/gold.png", back: "back" },
    { id: "lead", kind: "card", size_mm: [63, 88], front: "assets/lead.png", back: "back" },
  ],
  zones: [
    { id: "deck", layout: "stack", rect_mm: { x: 0, y: 0, w: 100, h: 100 }, visibility: "public" },
    {
      id: "hand",
      layout: "fan",
      rect_mm: { x: 0, y: -200, w: 300, h: 100 },
      owner: "each",
      visibility: "owner",
    },
  ],
  setup: {
    instances: [
      { def: "gold", zone: "deck", count: 3, face: "down" },
      { def: "lead", zone: "deck", count: 3, face: "down", shuffle: true },
    ],
  },
};
const INIT = { seats: ["0", "1"], seed: 7, options: {} };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function sandboxBuild(components: unknown = COMPONENTS) {
  const source = JSON.stringify(components);
  const files = { "assets/back.png": "a".repeat(64), "components.json": sha(source) };
  const index = Object.entries(files)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([path, digest]) => `${path}\t${digest}\n`)
    .join("");
  const build: HostBuild = { mode: "sandbox", components: "components.json", files, source };
  return { build, hash: sha(index) };
}

/** Identities a seat's view reveals: every `def` of an item it may identify. */
function identities(view: ClientView): string[] {
  return JSON.stringify(view).match(/"def":"(gold|lead)"/g) ?? [];
}

describe("sandbox games in the rules host", () => {
  it("verifies the components file against the build hash", async () => {
    const { build, hash } = sandboxBuild();
    expect(await loadBuild({ load: async () => build }, hash)).toEqual({
      kind: "sandbox",
      components: COMPONENTS,
    });
    await expect(
      loadBuild({ load: async () => ({ ...build, source: `${build.source} ` }) }, hash),
    ).rejects.toBeInstanceOf(GameError);
    const { build: noZones, hash: noZonesHash } = sandboxBuild({ schemaVersion: 1, defs: [] });
    await expect(loadBuild({ load: async () => noZones }, noZonesHash)).rejects.toBeInstanceOf(
      GameError,
    );
  });

  it("runs setup and manual operations without leaking hidden cards", async () => {
    const sandbox = await QuickJsSandbox.loadSandbox(COMPONENTS);
    try {
      await sandbox.create(INIT);
      let views = await sandbox.views();
      // The deck is face down: nobody may know any card in it.
      expect(identities(views["0"] as ClientView)).toEqual([]);
      expect(identities(views["1"] as ClientView)).toEqual([]);
      const deal = await sandbox.apply("0", {
        move: "manual",
        args: { op: "deal", from: "deck", to: ["hand:0", "hand:1"], count: 1 },
      });
      expect(deal).toMatchObject({ ok: true, event: { seq: 1 } });
      views = await sandbox.views();
      // Each seat now knows exactly its own card.
      expect(identities(views["0"] as ClientView)).toHaveLength(1);
      expect(identities(views["1"] as ClientView)).toHaveLength(1);
      expect(await sandbox.hash()).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      sandbox.dispose();
    }
  });

  it("ends a sandbox match with the same result and hash as the runtime in Node", async () => {
    const sandbox = await QuickJsSandbox.loadSandbox(COMPONENTS);
    try {
      await sandbox.create(INIT);
      const pass = { move: "manual", args: { op: "endTurn" } };
      const end = { move: "manual", args: { op: "endGame" } };
      expect(await sandbox.apply("0", pass)).toMatchObject({ ok: true });
      expect(await sandbox.apply("1", end)).toMatchObject({ ok: true, event: { seq: 2 } });
      const state = await sandbox.exportState();
      expect(state.result).toEqual({ winners: [], reason: "Ended by Seat 2" });
      const events = [
        { seq: 1, seat: "0", intent: pass },
        { seq: 2, seat: "1", intent: end },
      ];
      const local = replay(createSandboxDefinition(COMPONENTS), INIT, events);
      expect(await sandbox.hash()).toBe(await hashState(local));
      expect(await sandbox.apply("0", pass)).toMatchObject({ ok: false, code: "MATCH_FINISHED" });
    } finally {
      sandbox.dispose();
    }
  });

  it("hosts, recovers and replays a sandbox match through the client", async () => {
    const { build, hash } = sandboxBuild();
    const client = new RulesHostClient({ load: async () => build }, { warmSpareCount: 0 });
    try {
      await client.load(hash);
      await client.create("sandbox-1", { ...INIT, buildHash: hash });
      const outcome = await client.apply("sandbox-1", "1", {
        move: "manual",
        args: { op: "deal", from: "deck", to: ["hand:0", "hand:1"], count: 2 },
      });
      expect(outcome.ok).toBe(true);
      const before = await client.hash("sandbox-1");
      // Kill the process: the next call reloads the sandbox and replays the journal.
      const pid = client.processId("sandbox-1");
      if (pid === undefined) throw Error("No process");
      process.kill(pid);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await client.hash("sandbox-1")).toBe(before);
      const rejected = await client.apply("sandbox-1", "0", { move: "nonsense" });
      expect(rejected.ok).toBe(false);
    } finally {
      client.close();
    }
  });
});
