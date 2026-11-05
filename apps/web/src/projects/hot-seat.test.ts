import type { ComponentsFile, HotSeatMatchRecord, ItemPlacement, TableSnapshot } from "@bgp/schema";
import { afterEach, describe, expect, it } from "vitest";
import { type GameWorker, startGameWorker, type WorkerLike } from "../match/game-worker-client";
import type { WorkerInit } from "../workers/protocol";
import { startWorker } from "../workers/worker-main";
import { createHotSeat, type HotSeatController, mergeSnapshots } from "./hot-seat";

const COMPONENTS: ComponentsFile = {
  schemaVersion: 1,
  defs: [
    { id: "back", kind: "cardBack", image: "assets/back.png" },
    { id: "fish", kind: "card", name: "Fish", size_mm: [63, 88], front: "f.png", back: "back" },
    { id: "die", kind: "die", sides: 6, size_mm: 16 },
  ],
  zones: [
    {
      id: "deck",
      layout: "stack",
      rect_mm: { x: -200, y: 0, w: 100, h: 120 },
      visibility: "public",
    },
    { id: "market", layout: "row", rect_mm: { x: 0, y: 0, w: 200, h: 120 }, visibility: "public" },
    {
      id: "hand",
      label: "Hand",
      layout: "fan",
      rect_mm: { x: 0, y: -200, w: 300, h: 120 },
      visibility: "owner",
      owner: "each",
    },
  ],
  setup: {
    instances: [
      { def: "fish", zone: "deck", count: 6, face: "down", shuffle: true },
      { def: "die", zone: "market" },
    ],
  },
};

/** Runs the real worker entry on a MessageChannel instead of a Worker thread. */
class ChannelWorker implements WorkerLike {
  onerror: WorkerLike["onerror"] = null;
  onmessage: WorkerLike["onmessage"] = null;
  constructor() {
    setTimeout(() => this.onmessage?.({ data: { t: "booted" } } as MessageEvent), 0);
  }
  postMessage(message: WorkerInit, transfer: Transferable[]) {
    void startWorker(structuredClone(message), transfer[0] as MessagePort, {
      lockDown: () => [],
      importGame: async () => null,
    });
  }
  terminate() {}
}

const cleanup: (() => void)[] = [];
let ids = 0;
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop();
});

async function setUp(stored: HotSeatMatchRecord | null = null) {
  const worker: GameWorker = await startGameWorker({
    game: { kind: "sandbox" },
    components: COMPONENTS,
    createWorker: () => new ChannelWorker(),
    timeoutMs: 2000,
  });
  const saved: HotSeatMatchRecord[] = [];
  const hotSeat = createHotSeat({
    worker,
    persist: async (match) => {
      saved.push(structuredClone(match));
    },
    newId: () => `0192f3a4-5b6c-7d8e-9f01-${String(++ids).padStart(12, "0")}`,
    newSeed: () => 42,
    now: () => "2026-11-04T10:00:00.000Z",
  });
  cleanup.push(() => {
    hotSeat.destroy();
    worker.destroy();
  });
  await hotSeat.start(stored, "0192f3a4-5b6c-7d8e-9f01-23456789aaaa", 2);
  return { hotSeat, saved };
}

/** Resolves once the controller's state satisfies `test`. */
function until(hotSeat: HotSeatController, test: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), 3000);
    const check = () => {
      if (!test()) return;
      clearTimeout(timer);
      stop();
      resolve();
    };
    const stop = hotSeat.subscribe(check);
    check();
  });
}

const items = (snapshot: TableSnapshot | null, zone: string): ItemPlacement[] =>
  snapshot?.items.filter((item) => item.zone.startsWith(zone)) ?? [];

describe("hot-seat play", () => {
  it("starts a stored match for the project and deals with the platform's buttons", async () => {
    const { hotSeat, saved } = await setUp();
    await until(hotSeat, () => hotSeat.getState().snapshot !== null);
    expect(saved[0]).toMatchObject({
      projectId: "0192f3a4-5b6c-7d8e-9f01-23456789aaaa",
      init: { seats: ["0", "1"], seed: 42, options: {} },
      events: [],
    });
    const top = items(hotSeat.getState().snapshot, "deck").at(-1);
    if (!top) throw new Error("no deck");
    hotSeat.setSelection([top.id]);
    await until(hotSeat, () => hotSeat.getState().actions.some((a) => a.id === "deal:hand"));
    const deal = hotSeat.getState().actions.find((action) => action.id === "deal:hand");
    hotSeat.act(deal?.intent);
    await until(hotSeat, () => items(hotSeat.getState().snapshot, "hand").length === 2);
    expect(saved.at(-1)?.events).toEqual([{ seq: 1, seat: "0", intent: deal?.intent }]);
    // Seat 1 knows its own card only.
    const hands = items(hotSeat.getState().snapshot, "hand");
    expect(hands.find((item) => item.zone === "hand:0")?.def).toBe("fish");
    expect(hands.find((item) => item.zone === "hand:1")).not.toHaveProperty("def");
    expect(hotSeat.getState().selection).toEqual([]);
  });

  it("shows each seat its own view and the union of all seats read-only", async () => {
    const { hotSeat } = await setUp();
    await until(hotSeat, () => hotSeat.getState().snapshot !== null);
    const deck = items(hotSeat.getState().snapshot, "deck");
    hotSeat.act({
      move: "manual",
      args: { op: "deal", from: "deck", to: ["hand:0", "hand:1"], count: 1, face: "up" },
    });
    await until(hotSeat, () => items(hotSeat.getState().snapshot, "hand").length === 2);

    hotSeat.setViewing("1");
    await until(hotSeat, () => items(hotSeat.getState().snapshot, "hand:1")[0]?.def === "fish");
    expect(items(hotSeat.getState().snapshot, "hand:0")[0]).not.toHaveProperty("def");

    hotSeat.setViewing("all");
    await until(
      hotSeat,
      () => hotSeat.getState().viewing === "all" && hotSeat.getState().snapshot !== null,
    );
    const all = hotSeat.getState().snapshot;
    expect(items(all, "hand").map((item) => item.def)).toEqual(["fish", "fish"]);
    // Nobody may see the deck, so neither may the merged view.
    expect(items(all, "deck").every((item) => item.def === undefined)).toBe(true);
    expect(items(all, "deck")).toHaveLength(deck.length - 2);
    expect(all?.items.some((item) => item.draggable || item.selectable)).toBe(false);
    expect(all?.zones.some((zone) => zone.droppable)).toBe(false);
    expect(hotSeat.getState().actions).toEqual([]);
    // Moves are made from a seat, never from the merged view.
    hotSeat.act({ move: "manual", args: { op: "endTurn" } });
    expect(hotSeat.getState().pending).toBe(false);
  });

  it("reports the game's message for a rejected move and keeps the match", async () => {
    const { hotSeat, saved } = await setUp();
    await until(hotSeat, () => hotSeat.getState().snapshot !== null);
    const before = saved.length;
    hotSeat.act({ move: "manual", args: { op: "shuffle", zone: "hand:1" } });
    await until(hotSeat, () => hotSeat.getState().rejection !== null);
    expect(hotSeat.getState().rejection).toBe("Invalid manual operation");
    expect(saved).toHaveLength(before);
    hotSeat.dismissRejection();
    expect(hotSeat.getState().rejection).toBeNull();
  });

  it("resumes a stored match, and starts over when its log no longer fits", async () => {
    const first = await setUp();
    await until(first.hotSeat, () => first.hotSeat.getState().snapshot !== null);
    first.hotSeat.act({ move: "manual", args: { op: "endTurn" } });
    await until(first.hotSeat, () => first.hotSeat.getState().match?.events.length === 1);
    const stored = first.saved.at(-1);
    if (!stored) throw new Error("nothing saved");

    const resumed = await setUp(stored);
    await until(resumed.hotSeat, () => resumed.hotSeat.getState().snapshot !== null);
    expect(resumed.hotSeat.getState().match).toEqual(stored);
    expect(resumed.hotSeat.getState().snapshot?.hud?.find((entry) => entry.active)?.seat).toBe("1");
    expect(resumed.hotSeat.getState().notice).toBeNull();

    const broken: HotSeatMatchRecord = {
      ...stored,
      events: [
        { seq: 1, seat: "0", intent: { move: "manual", args: { op: "flip", item: "gone" } } },
      ],
    };
    const restarted = await setUp(broken);
    await until(restarted.hotSeat, () => restarted.hotSeat.getState().snapshot !== null);
    expect(restarted.hotSeat.getState().notice).toMatch(/no longer fits/);
    expect(restarted.hotSeat.getState().match?.events).toEqual([]);
    expect(restarted.hotSeat.getState().match?.id).not.toBe(stored.id);
  });

  it("starts a new game with another number of seats", async () => {
    const { hotSeat, saved } = await setUp();
    await until(hotSeat, () => hotSeat.getState().snapshot !== null);
    hotSeat.setViewing("1");
    await hotSeat.newGame(3);
    await until(hotSeat, () => hotSeat.getState().snapshot?.hud?.length === 3);
    expect(saved.at(-1)?.init.seats).toEqual(["0", "1", "2"]);
    expect(hotSeat.getState().viewing).toBe("1");
  });
});

describe("all seats view", () => {
  const base: TableSnapshot = {
    table: { size_mm: [800, 600] },
    zones: [{ id: "z", layout: "row", rect_mm: { x: 0, y: 0, w: 100, h: 100 }, droppable: true }],
    items: [],
  };
  it("prefers any seat's identified copy of an item and keeps unknown items hidden", () => {
    const merged = mergeSnapshots([
      {
        ...base,
        items: [
          { id: "a", zone: "z", index: 0, face: "down", back: "back", draggable: true },
          { id: "b", zone: "z", index: 1, face: "up", def: "fish", selectable: true },
          { id: "c", zone: "z", index: 2, face: "down", back: "back" },
        ],
      },
      {
        ...base,
        table: { size_mm: [900, 600] },
        items: [
          { id: "a", zone: "z", index: 0, face: "up", def: "tea", highlight: "legal" },
          { id: "b", zone: "z", index: 1, face: "down", back: "back" },
          { id: "c", zone: "z", index: 2, face: "down", back: "back" },
        ],
      },
    ]);
    expect(merged).toEqual({
      table: { size_mm: [900, 600] },
      zones: [{ ...base.zones[0], droppable: false }],
      items: [
        { id: "a", zone: "z", index: 0, face: "up", def: "tea" },
        { id: "b", zone: "z", index: 1, face: "up", def: "fish" },
        { id: "c", zone: "z", index: 2, face: "down", back: "back" },
      ],
    });
    expect(mergeSnapshots([])).toBeNull();
  });
});
