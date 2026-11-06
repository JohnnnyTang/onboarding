import type { AcceptedEvent, ComponentsFile, Json, ReplayResponse } from "@bgp/schema";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerInit } from "../workers/protocol";
import { startWorker } from "../workers/worker-main";
import { type GameWorker, startGameWorker, type WorkerLike } from "./game-worker-client";
import { createReplayViewer, REPLAY_CHUNK, type ReplayController } from "./replay-viewer";

const COMPONENTS: ComponentsFile = {
  schemaVersion: 1,
  defs: [
    { id: "back", kind: "cardBack", image: "assets/back.png" },
    { id: "fish", kind: "card", name: "Fish", size_mm: [63, 88], front: "f.png", back: "back" },
  ],
  zones: [
    { id: "deck", layout: "stack", rect_mm: { x: 0, y: 0, w: 100, h: 120 }, visibility: "public" },
    {
      id: "hand",
      layout: "fan",
      rect_mm: { x: 0, y: -200, w: 300, h: 120 },
      visibility: "owner",
      owner: "each",
    },
  ],
  setup: { instances: [{ def: "fish", zone: "deck", count: 6, face: "down", shuffle: true }] },
};

/** Runs the real worker entry on a MessageChannel instead of a Worker thread. */
class ChannelWorker implements WorkerLike {
  onerror: WorkerLike["onerror"] = null;
  onmessage: WorkerLike["onmessage"] = null;
  constructor(private readonly withDigest: boolean) {
    setTimeout(() => this.onmessage?.({ data: { t: "booted" } } as MessageEvent), 0);
  }
  postMessage(message: WorkerInit, transfer: Transferable[]) {
    void startWorker(structuredClone(message), transfer[0] as MessagePort, {
      lockDown: () => [],
      importGame: async () => null,
      ...(this.withDigest ? { digest: (bytes) => crypto.subtle.digest("SHA-256", bytes) } : {}),
    });
  }
  terminate() {}
}

function sandboxWorker(digest = true): Promise<GameWorker> {
  return startGameWorker({
    game: { kind: "sandbox" },
    components: COMPONENTS,
    createWorker: () => new ChannelWorker(digest),
    timeoutMs: 2000,
  });
}

/**
 * A 2-seat sandbox match, played hot-seat in its own worker: seat 2 is dealt one card face
 * down, then turns pass `turns` times. The worker's hashes match hashState (worker.test.ts).
 */
async function recorded(turns: number): Promise<ReplayResponse> {
  const init = { seats: ["0", "1"], seed: 5, options: {} };
  const worker = await sandboxWorker();
  try {
    await worker.hotSeat.create(init);
    const events: AcceptedEvent[] = [];
    const play = async (seat: string, args: Json) => {
      const outcome = await worker.hotSeat.apply(seat, { move: "manual", args });
      if (!outcome.ok) throw new Error(outcome.code);
      events.push(outcome.event);
    };
    await play("0", { op: "deal", from: "deck", to: ["hand:1"], count: 1, face: "down" });
    for (let turn = 0; turn < turns; turn += 1) {
      await play((await worker.hotSeat.view(null)).ctx.currentSeat, { op: "endTurn" });
    }
    await worker.replay.start(init);
    await worker.replay.append(events);
    const finalHash = await worker.replay.hash(events.length);
    return { buildHash: "a".repeat(64), ...init, events, finalHash };
  } finally {
    worker.destroy();
  }
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop();
});

async function setUp(replay: ReplayResponse, options: { digest?: boolean } = {}) {
  const worker = await sandboxWorker(options.digest ?? true);
  let presents = 0;
  const counted = {
    ...worker,
    stopped: false,
    present: (...args: Parameters<GameWorker["present"]>) => {
      presents += 1;
      return worker.present(...args);
    },
  };
  const viewer = createReplayViewer(counted, replay);
  cleanup.push(() => {
    viewer.destroy();
    worker.destroy();
  });
  return { viewer, presents: () => presents };
}

function until(viewer: ReplayController, test: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), 3000);
    const check = () => {
      if (!test()) return;
      clearTimeout(timer);
      stop();
      resolve();
    };
    const stop = viewer.subscribe(check);
    check();
  });
}

const handCard = (viewer: ReplayController) =>
  viewer.getState().snapshot?.items.find((item) => item.zone === "hand:1");

describe("replay viewer", () => {
  it("rebuilds in chunks, checks the final hash and steps through the match", async () => {
    const replay = await recorded(REPLAY_CHUNK + 10);
    const { viewer } = await setUp(replay);
    const loaded: number[] = [];
    viewer.subscribe(() => loaded.push(viewer.getState().loaded));
    await viewer.load();
    expect(new Set(loaded)).toEqual(new Set([REPLAY_CHUNK, REPLAY_CHUNK + 11]));
    const state = viewer.getState();
    expect(state.status).toBe("ready");
    expect(state.hashCheck).toEqual({ status: "match", hash: replay.finalHash });
    // The setup: nothing has been dealt yet.
    expect(state.shownSeq).toBe(0);
    expect(handCard(viewer)).toBeUndefined();
    viewer.step(1);
    await until(viewer, () => viewer.getState().shownSeq === 1);
    // The first seat is shown first: it may not identify seat 2's card.
    expect(state.viewing).toBe("0");
    expect(handCard(viewer)).not.toHaveProperty("def");
    viewer.setViewing("1");
    await until(viewer, () => viewer.getState().shownSeq === 1);
    expect(handCard(viewer)).toMatchObject({ def: "fish" });
    viewer.setViewing("all");
    await until(viewer, () => viewer.getState().shownSeq === 1);
    expect(handCard(viewer)).toMatchObject({ def: "fish" });
    viewer.goTo(10_000);
    await until(viewer, () => viewer.getState().shownSeq === replay.events.length);
    expect(viewer.getState().view?.ctx.moveNumber).toBe(replay.events.length);
    viewer.step(-5);
    viewer.goTo(-3);
    await until(viewer, () => viewer.getState().shownSeq === 0);
    expect(viewer.getState().seq).toBe(0);
  });

  it("draws only the latest of many quick steps", async () => {
    const replay = await recorded(40);
    const { viewer, presents } = await setUp(replay);
    viewer.setViewing("0");
    await viewer.load();
    const before = presents();
    for (let step = 0; step < 30; step += 1) viewer.step(1);
    await until(viewer, () => viewer.getState().shownSeq === 30);
    expect(presents() - before).toBeLessThan(30);
    expect(viewer.getState().view?.ctx.moveNumber).toBe(30);
  });

  it("reports a final hash that differs from the server's", async () => {
    const replay = { ...(await recorded(3)), finalHash: "0".repeat(64) };
    const { viewer } = await setUp(replay);
    await viewer.load();
    expect(viewer.getState()).toMatchObject({
      status: "ready",
      hashCheck: { status: "mismatch", expected: "0".repeat(64) },
    });
  });

  it("skips the hash check without a digest", async () => {
    const { viewer } = await setUp(await recorded(3), { digest: false });
    await viewer.load();
    expect(viewer.getState()).toMatchObject({
      status: "ready",
      hashCheck: { status: "unavailable" },
    });
  });

  it("fails when the events do not apply to this game", async () => {
    const replay = await recorded(3);
    const [first, ...rest] = replay.events;
    if (!first) throw new Error("missing event");
    const invalid = { move: "manual", args: { op: "shuffle", zone: "hand:1" } };
    const { viewer } = await setUp({ ...replay, events: [{ ...first, intent: invalid }, ...rest] });
    await viewer.load();
    expect(viewer.getState()).toMatchObject({ status: "failed", snapshot: null });
    expect(viewer.getState().error?.reason).toBe("failed");
  });
});
