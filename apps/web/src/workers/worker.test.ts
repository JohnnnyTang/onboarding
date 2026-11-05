import { invalid } from "@bgp/rules";
import type { ClientView, ComponentsFile, GameDefinition, TableSnapshot } from "@bgp/schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  type GameWorker,
  GameWorkerError,
  startGameWorker,
  type WorkerLike,
} from "../match/game-worker-client";
import { lockDownGlobals, REMOVED_GLOBALS, THROWING_GLOBALS } from "./lockdown";
import type { WorkerInit } from "./protocol";
import { startWorker, type WorkerDeps } from "./worker-main";

type Counter = { count: number; secret: number };

const COMPONENTS: ComponentsFile = {
  schemaVersion: 1,
  defs: [{ id: "token", kind: "token", shape: "circle", size_mm: [20, 20], front: "a.png" }],
};

/** A small game: "add" adds a die roll; "bad" is always invalid; the view hides `secret`. */
const counter: GameDefinition<Counter, { count: number }> = {
  sdk: 1,
  setup: ({ random }) => ({ count: 0, secret: random.int(1, 100) }),
  moves: {
    add: {
      apply(state, ctx) {
        state.count += ctx.random.die(6);
        ctx.events.endTurn();
      },
    },
    bad: { apply: () => invalid("NOPE", "Not that.") },
  },
  playerView: (state) => ({ count: state.count }),
  present(view, info): TableSnapshot {
    if (view.game.count < 0) throw new Error("secret 42");
    return {
      table: { size_mm: [400, 300] },
      zones: [{ id: "pool", layout: "row", rect_mm: { x: 0, y: 0, w: 200, h: 100 } }],
      items: [{ id: "t", zone: "pool", index: 0, face: "up", def: "token", selectable: true }],
      prompt: `Seat ${info.seat ?? "-"} sees ${view.game.count} (${info.components.defs.length})`,
    };
  },
  interpret: (gesture) => (gesture.kind === "click" ? { move: "add" } : null),
  actions: (_view, _info, selection) => [
    { id: "add", label: `Add (${selection.length})`, enabled: true, intent: { move: "add" } },
  ],
};

const view = (count: number): ClientView => ({
  ctx: {
    seats: ["0", "1"],
    currentSeat: "0",
    activeSeats: ["0"],
    phase: "main",
    turn: 1,
    moveNumber: 0,
    options: {},
  },
  game: { count },
  result: null,
});

/** Games by bundle source, standing in for evaluating a real bundle. */
const GAMES: Record<string, unknown> = {
  counter,
  "not-a-game": { sdk: 1 },
  "bad-present": { ...counter, present: () => ({ table: { size_mm: [1.5, 2] } }) },
  "function-present": { ...counter, present: () => () => 1 },
};

/** Runs the real worker entry on a MessageChannel port instead of a Worker thread. */
class FakeWorker implements WorkerLike {
  onerror: WorkerLike["onerror"] = null;
  onmessage: WorkerLike["onmessage"] = null;
  terminated = false;
  constructor(
    private readonly deps: Partial<WorkerDeps> = {},
    boot = true,
  ) {
    if (boot) setTimeout(() => this.onmessage?.({ data: { t: "booted" } } as MessageEvent), 0);
  }
  postMessage(message: WorkerInit, transfer: Transferable[]) {
    const port = transfer[0] as MessagePort;
    const deps: WorkerDeps = {
      lockDown: () => [],
      importGame: async (source) => GAMES[source],
      ...this.deps,
    };
    void startWorker(structuredClone(message), port, deps);
  }
  terminate() {
    this.terminated = true;
  }
}

const started: GameWorker[] = [];
async function start(source: string, worker = new FakeWorker(), timeoutMs = 200) {
  const game = await startGameWorker({
    game: { kind: "bundle", source },
    components: COMPONENTS,
    createWorker: () => worker,
    timeoutMs,
    loadTimeoutMs: 500,
  });
  started.push(game);
  return game;
}
afterEach(() => {
  for (const game of started.splice(0)) game.destroy();
});

describe("game worker", () => {
  it("presents, interprets and lists actions from a seat's view", async () => {
    const game = await start("counter");
    const snapshot = await game.present(view(3), "1");
    expect(snapshot.prompt).toBe("Seat 1 sees 3 (1)");
    expect(await game.interpret({ kind: "click", item: "t" }, view(3), "0")).toEqual({
      move: "add",
    });
    expect(await game.interpret({ kind: "clickZone", zone: "pool" }, view(3), "0")).toBeNull();
    expect(await game.actions(view(3), "0", ["t"])).toEqual([
      { id: "add", label: "Add (1)", enabled: true, intent: { move: "add" } },
    ]);
  });

  it("runs a deterministic hot-seat match", async () => {
    const play = async () => {
      const game = await start("counter");
      await game.hotSeat.create({ seats: ["0", "1"], seed: 7, options: {} });
      const first = await game.hotSeat.apply("0", { move: "add" });
      const wrongSeat = await game.hotSeat.apply("0", { move: "add" });
      const rejected = await game.hotSeat.apply("1", { move: "bad" });
      return { first, wrongSeat, rejected, view: await game.hotSeat.view("0") };
    };
    const a = await play();
    expect(a.first).toEqual({ ok: true, event: { seq: 1, seat: "0", intent: { move: "add" } } });
    expect(a.wrongSeat).toMatchObject({ ok: false, code: "NOT_YOUR_TURN" });
    expect(a.rejected).toEqual({
      ok: false,
      code: "INVALID_MOVE",
      gameCode: "NOPE",
      message: "Not that.",
    });
    expect(a.view.game).not.toHaveProperty("secret");
    expect(await play()).toEqual(a);
  });

  it("resumes a hot-seat match from its events and refuses an invalid log", async () => {
    const init = { seats: ["0", "1"], seed: 7, options: {} };
    const live = await start("counter");
    await live.hotSeat.create(init);
    const events = [];
    for (const seat of ["0", "1", "0"]) {
      const outcome = await live.hotSeat.apply(seat, { move: "add" });
      if (!outcome.ok) throw new Error("move rejected");
      events.push(outcome.event);
    }
    const resumed = await start("counter");
    await resumed.hotSeat.create(init, events);
    expect(await resumed.hotSeat.view("1")).toEqual(await live.hotSeat.view("1"));
    await expect(
      resumed.hotSeat.create(init, [{ seq: 2, seat: "0", intent: { move: "add" } }]),
    ).rejects.toMatchObject({ reason: "failed" });
    // A failed resume leaves no match behind.
    await expect(resumed.hotSeat.view("0")).rejects.toMatchObject({ reason: "failed" });
  });

  it("runs the built-in sandbox game without a bundle", async () => {
    let imported = false;
    const worker = new FakeWorker({
      importGame: async () => {
        imported = true;
        return counter;
      },
    });
    const sandbox: ComponentsFile = {
      ...COMPONENTS,
      zones: [
        {
          id: "pool",
          layout: "row",
          rect_mm: { x: 0, y: 0, w: 200, h: 100 },
          visibility: "public",
        },
        {
          id: "hand",
          layout: "fan",
          rect_mm: { x: 0, y: -200, w: 200, h: 100 },
          visibility: "owner",
          owner: "each",
        },
      ],
      setup: { instances: [{ def: "token", zone: "pool", count: 2 }] },
    };
    const game = await startGameWorker({
      game: { kind: "sandbox" },
      components: sandbox,
      createWorker: () => worker,
      timeoutMs: 200,
      loadTimeoutMs: 500,
    });
    started.push(game);
    expect(imported).toBe(false);
    await game.hotSeat.create({ seats: ["0", "1"], seed: 3, options: {} });
    const seatView = await game.hotSeat.view("1");
    const snapshot = await game.present(seatView, "1");
    const token = snapshot.items[0];
    if (!token) throw new Error("missing token");
    expect(snapshot.zones.map((zone) => zone.id)).toEqual(["pool", "hand:0", "hand:1"]);
    const intent = await game.interpret(
      { kind: "drop", item: token.id, from: "pool", to: "hand:1", index: 0 },
      seatView,
      "1",
    );
    expect(intent).toEqual({
      move: "manual",
      args: { op: "move", item: token.id, to: "hand:1", index: 0 },
    });
    if (!intent) throw new Error("no intent");
    expect(await game.hotSeat.apply("1", intent)).toMatchObject({ ok: true });
    const other = await game.present(await game.hotSeat.view("0"), "0");
    expect(other.items.find((item) => item.zone === "hand:1")).not.toHaveProperty("def");
    expect((await game.actions(seatView, "1", [token.id])).map((action) => action.id)).toContain(
      "flip",
    );
  });

  it("refuses a sandbox components file without zones", async () => {
    await expect(
      startGameWorker({
        game: { kind: "sandbox" },
        components: COMPONENTS,
        createWorker: () => new FakeWorker(),
        loadTimeoutMs: 500,
      }),
    ).rejects.toMatchObject({ reason: "load" });
  });

  it("reports game errors without their messages", async () => {
    const game = await start("counter");
    const error = await game.present(view(-1), "0").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GameWorkerError);
    expect((error as GameWorkerError).reason).toBe("failed");
    expect(String((error as Error).message)).not.toContain("42");
    // The worker keeps serving after a thrown game error.
    expect((await game.present(view(1), "0")).prompt).toBe("Seat 0 sees 1 (1)");
  });

  it("rejects output that is not a valid snapshot or cannot be sent", async () => {
    const bad = await start("bad-present");
    await expect(bad.present(view(1), "0")).rejects.toMatchObject({ reason: "invalid" });
    const fn = await start("function-present");
    await expect(fn.present(view(1), "0")).rejects.toMatchObject({ reason: "failed" });
  });

  it("stops the worker when a call misses its deadline", async () => {
    const worker = new FakeWorker();
    // A promise cannot be cloned, so make the host hang instead: never answer "present".
    const game = await startGameWorker({
      game: { kind: "bundle", source: "counter" },
      components: COMPONENTS,
      createWorker: () => ({
        onerror: null,
        get onmessage() {
          return worker.onmessage;
        },
        set onmessage(handler) {
          worker.onmessage = handler;
        },
        terminate: () => worker.terminate(),
        postMessage(message, transfer) {
          const port = transfer[0] as MessagePort;
          const fake = new MessageChannel();
          worker.postMessage(message, [fake.port2]);
          // Relay everything except "present" requests, which are dropped.
          fake.port1.onmessage = (event) => port.postMessage(event.data);
          port.onmessage = (event) => {
            if ((event.data as { op?: string }).op !== "present")
              fake.port1.postMessage(event.data);
          };
        },
      }),
      timeoutMs: 50,
    });
    started.push(game);
    await expect(game.present(view(1), "0")).rejects.toMatchObject({ reason: "timeout" });
    expect(worker.terminated).toBe(true);
    expect(game.stopped).toBe(true);
    await expect(game.actions(view(1), "0", [])).rejects.toMatchObject({ reason: "stopped" });
  });

  it("gives up when the worker script never starts", async () => {
    const worker = new FakeWorker({}, false);
    await expect(
      startGameWorker({
        game: { kind: "bundle", source: "counter" },
        components: COMPONENTS,
        createWorker: () => worker,
        bootTimeoutMs: 20,
      }),
    ).rejects.toMatchObject({ reason: "load" });
    expect(worker.terminated).toBe(true);
  });

  it("refuses to load a bundle without a game definition", async () => {
    await expect(start("not-a-game")).rejects.toMatchObject({ reason: "load" });
  });

  it("never loads the game when the lockdown is incomplete", async () => {
    let imported = false;
    const worker = new FakeWorker({
      lockDown: () => ["fetch"],
      importGame: async () => {
        imported = true;
        return counter;
      },
    });
    await expect(start("counter", worker)).rejects.toMatchObject({ reason: "load" });
    expect(imported).toBe(false);
    expect(worker.terminated).toBe(true);
  });
});

describe("worker lockdown", () => {
  function fakeScope() {
    const stop = { addEventListener() {} };
    const workerProto = Object.create(stop) as Record<string, unknown>;
    workerProto.fetch = () => "network";
    workerProto.indexedDB = { open: () => "db" };
    const scope = Object.create(workerProto) as Record<string, unknown>;
    scope.Math = Object.create(Math);
    scope.WebSocket = class {};
    scope.postMessage = () => "posted";
    scope.Date = Date;
    return { scope, stop, workerProto };
  }

  it("makes host-locked names throw and browser capabilities undefined", () => {
    const { scope, stop } = fakeScope();
    expect(lockDownGlobals(scope, [stop])).toEqual([]);
    for (const name of THROWING_GLOBALS) expect(() => scope[name]).toThrow();
    for (const name of REMOVED_GLOBALS) expect(scope[name]).toBeUndefined();
    expect(() => (scope.Math as typeof Math).random()).toThrow();
    // Values cannot be put back.
    expect(() => {
      scope.fetch = () => "again";
    }).toThrow();
    expect(Reflect.defineProperty(scope, "indexedDB", { value: {} })).toBe(false);
  });

  it("removes capabilities from the global's own prototypes but not shared ones", () => {
    const { scope, stop, workerProto } = fakeScope();
    lockDownGlobals(scope, [stop]);
    expect(Object.hasOwn(workerProto, "fetch")).toBe(false);
    expect(Object.hasOwn(workerProto, "indexedDB")).toBe(false);
    expect(typeof stop.addEventListener).toBe("function");
  });

  it("reports names it cannot lock", () => {
    const { scope, stop } = fakeScope();
    Object.defineProperty(scope, "fetch", { value: () => "network", configurable: false });
    expect(lockDownGlobals(scope, [stop])).toContain("fetch");
  });
});
