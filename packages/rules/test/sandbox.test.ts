import {
  type AcceptedEvent,
  type ComponentsFile,
  JsonSchema,
  type ManualOp,
  type MatchState,
  type SandboxState,
  SandboxStateSchema,
  SandboxViewSchema,
  sandboxSnapshotForSeatSchema,
  TableSnapshotSchema,
} from "@bgp/schema";
import { describe, expect, test } from "vitest";
import {
  applyIntent,
  canonicalJson,
  createMatch,
  createRandom,
  createSandboxDefinition,
  hashState,
  replay,
  seedRandom,
  viewFor,
} from "../src/index.js";

const components: ComponentsFile = {
  schemaVersion: 1,
  defs: [
    { id: "back", kind: "cardBack", image: "assets/back.png" },
    { id: "fish", kind: "card", size_mm: [63, 88], front: "assets/fish.png", back: "back" },
    { id: "tea", kind: "card", size_mm: [63, 88], front: "assets/tea.png", back: "back" },
    { id: "die", kind: "die", sides: 6, size_mm: 15 },
    { id: "coin", kind: "token", shape: "circle", size_mm: [10, 10], front: "assets/coin.png" },
    { id: "board", kind: "board", size_mm: [100, 100], image: "assets/board.png" },
    { id: "piece", kind: "piece", size_mm: [10, 10, 10], image: "assets/piece.png" },
  ],
  zones: [
    {
      id: "deck",
      layout: "stack",
      rect_mm: { x: -150, y: 0, w: 100, h: 100 },
      visibility: "public",
    },
    {
      id: "market",
      layout: "row",
      rect_mm: { x: 0, y: 0, w: 200, h: 100 },
      visibility: "public",
      label: "Market",
    },
    {
      id: "hand",
      layout: "fan",
      rect_mm: { x: 0, y: -150, w: 200, h: 100 },
      visibility: "owner",
      owner: "each",
    },
    {
      id: "table",
      layout: "free",
      rect_mm: { x: 150.2, y: 0.3, w: 100.2, h: 100.2 },
      visibility: "public",
    },
    {
      id: "grid",
      layout: "grid",
      rect_mm: { x: 0, y: 150, w: 100, h: 100 },
      visibility: "public",
      grid: { cols: 2, rows: 2 },
    },
  ],
  setup: {
    instances: [
      { def: "fish", zone: "deck", count: 5, face: "down" },
      { def: "tea", zone: "deck", count: 4, face: "down", shuffle: true },
      { def: "die", zone: "market" },
      { def: "coin", zone: "market" },
      { def: "board", zone: "table" },
      { def: "piece", zone: "grid" },
      { def: "fish", zone: "hand" },
    ],
  },
};
const init = { seats: ["0", "1", "2"], seed: 42, options: {} };
const def = createSandboxDefinition(components);

function item(state: MatchState<SandboxState>, zone: string, index = 0) {
  const found = state.game.items.find((item) => item.zone === zone && item.index === index);
  if (!found) throw new Error("Missing fixture item");
  return found;
}
function act(state: MatchState<SandboxState>, op: ManualOp, seat = "0") {
  const result = applyIntent(def, state, seat, { move: "manual", args: JsonSchema.parse(op) });
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  expect(SandboxStateSchema.safeParse(result.state.game).success).toBe(true);
  for (const zone of new Set(result.state.game.items.map((item) => item.zone))) {
    const indices = result.state.game.items
      .filter((item) => item.zone === zone)
      .map((item) => item.index);
    expect(indices).toEqual(indices.map((_, index) => index));
  }
  return result;
}

test("setup expands each-owned zones and instances, initializes components, and is detached", () => {
  const declarations = JSON.parse(JSON.stringify(components)) as ComponentsFile;
  const localDef = createSandboxDefinition(declarations);
  declarations.defs.length = 0;
  const state = createMatch(localDef, init);
  expect(state.game.items).toHaveLength(16);
  expect(["hand:0", "hand:1", "hand:2"].map((zone) => item(state, zone).face)).toEqual([
    "up",
    "up",
    "up",
  ]);
  expect(item(state, "market").value).toBe(1);
  expect(item(state, "table").pos_mm).toEqual([150, 0]);
  expect(state.game.items.every((item) => /^i[a-f0-9]{32}$/.test(item.id))).toBe(true);
  expect(new Set(state.game.items.map((item) => item.id)).size).toBe(state.game.items.length);
  expect(createMatch(localDef, init)).toEqual(state);
  expect(() => createSandboxDefinition({ schemaVersion: 1, defs: [] })).toThrow();
  expect(() => createSandboxDefinition({ ...components, defs: [] })).toThrow();
});

test("invalid setup references, card backs as items, owners, and expanded collisions fail safely", () => {
  for (const changed of [
    { ...components, setup: { instances: [{ def: "fish", zone: "hand:7" }] } },
    { ...components, setup: { instances: [{ def: "back", zone: "deck" }] } },
    {
      ...components,
      zones: [
        ...(components.zones ?? []),
        {
          id: "other",
          layout: "row" as const,
          rect_mm: { x: 0, y: 0, w: 10, h: 10 },
          visibility: "owner" as const,
          owner: "7",
        },
      ],
    },
    {
      ...components,
      zones: [
        ...(components.zones ?? []),
        {
          id: "hand:0",
          layout: "row" as const,
          rect_mm: { x: 0, y: 0, w: 10, h: 10 },
          visibility: "public" as const,
        },
      ],
    },
  ]) {
    expect(() => createMatch(createSandboxDefinition(changed), init)).toThrow(
      "Game initialization failed",
    );
  }
});

describe("manual operations", () => {
  test("any participating seat can move, reorder, give to another hand, and preserve or override face", () => {
    const start = createMatch(def, init);
    const card = item(start, "deck", 0);
    let state = act(start, { op: "move", item: card.id, to: "market", index: 1 }, "2").state;
    expect(item(state, "market", 1)).toMatchObject({ id: card.id, face: "down" });
    state = act(state, { op: "move", item: card.id, to: "market", index: 0, face: "up" }).state;
    expect(item(state, "market")).toMatchObject({ id: card.id, face: "up" });
    state = act(state, { op: "move", item: card.id, to: "hand:1" }, "2").state;
    expect(item(state, "hand:1", 1)).toMatchObject({ id: card.id, face: "up" });
    expect(start.game.items).toHaveLength(16);
    expect(item(start, "deck").id).toBe(card.id);
  });

  test("free moves accept table boundaries, preserve same-zone position, and clear it on leaving", () => {
    let state = createMatch(def, init);
    const coin = item(state, "market", 1).id;
    state = act(state, { op: "move", item: coin, to: "table", pos_mm: [400, -300] }).state;
    expect(item(state, "table", 1).pos_mm).toEqual([400, -300]);
    state = act(state, { op: "move", item: coin, to: "table", index: 0 }).state;
    expect(item(state, "table").pos_mm).toEqual([400, -300]);
    state = act(state, { op: "move", item: coin, to: "grid" }).state;
    expect(item(state, "grid", 1)).not.toHaveProperty("pos_mm");
  });

  test("flip toggles; rotate uses absolute degrees; roll stays within the die's sides", () => {
    let state = createMatch(def, init);
    const die = item(state, "market").id;
    state = act(state, { op: "flip", item: die }).state;
    expect(item(state, "market").face).toBe("down");
    state = act(state, { op: "flip", item: die }).state;
    expect(item(state, "market").face).toBe("up");
    state = act(state, { op: "rotate", item: die, deg: 359 }).state;
    state = act(state, { op: "rotate", item: die, deg: 1 }).state;
    expect(item(state, "market").rotation_deg).toBe(1);
    for (let index = 0; index < 30; index += 1) {
      state = act(state, { op: "roll", item: die }, "1").state;
      expect(item(state, "market").value).toBeGreaterThanOrEqual(1);
      expect(item(state, "market").value).toBeLessThanOrEqual(6);
    }
  });

  test("deal takes the top round-robin, count per target, defaulting down only for owner zones", () => {
    const start = createMatch(def, init);
    const top = Array.from({ length: 9 }, (_, index) => item(start, "deck", index)).reverse();
    const state = act(start, {
      op: "deal",
      from: "deck",
      to: ["hand:0", "hand:1"],
      count: 2,
    }).state;
    expect(item(state, "hand:0", 1)).toMatchObject({ id: top[0]?.id, face: "down" });
    expect(item(state, "hand:1", 1)).toMatchObject({ id: top[1]?.id, face: "down" });
    expect(item(state, "hand:0", 2).id).toBe(top[2]?.id);
    expect(item(state, "hand:1", 2).id).toBe(top[3]?.id);
    expect(state.game.items.filter((item) => item.zone === "deck")).toHaveLength(5);
    const publicDeal = act(state, { op: "deal", from: "hand:0", to: ["table"], count: 1 }).state;
    expect(item(publicDeal, "table", 1)).toMatchObject({ face: "down", pos_mm: [150, 0] });
    const faceUp = act(state, {
      op: "deal",
      from: "deck",
      to: ["hand:1"],
      count: 1,
      face: "up",
    }).state;
    expect(item(faceUp, "hand:1", 3).face).toBe("up");
  });

  test("shuffle changes every ID and order, including known cards, without changing other zones", () => {
    const start = createMatch(def, init);
    const before = start.game.items.filter((item) => item.zone === "deck");
    const state = act(start, { op: "shuffle", zone: "deck" }, "2").state;
    const after = state.game.items.filter((item) => item.zone === "deck");
    expect(after.map((item) => item.def)).not.toEqual(before.map((item) => item.def));
    expect(after.every((item) => !before.some((old) => old.id === item.id))).toBe(true);
    expect(state.game.items.filter((item) => item.zone !== "deck")).toEqual(
      start.game.items.filter((item) => item.zone !== "deck"),
    );
    for (const seat of [...init.seats, null]) {
      const view = viewFor(def, state, seat);
      const text = canonicalJson({ view, snapshot: def.present(view, { components, seat }) });
      for (const old of before) expect(text).not.toContain(old.id);
    }
    // An empty zone is a valid no-op; stale IDs are invalid after a shuffle.
    const cleared = act(state, { op: "move", item: item(state, "grid").id, to: "market" }).state;
    const empty = act(cleared, { op: "shuffle", zone: "grid" }).state;
    expect(empty.game.items).toHaveLength(start.game.items.length);
    expect(
      applyIntent(def, state, "0", {
        move: "manual",
        args: { op: "flip", item: before[0]?.id ?? "" },
      }),
    ).toMatchObject({ ok: false, code: "INVALID_ARGS" });
  });

  test("endTurn advances the HUD turn while every seat may still act", () => {
    const state = act(createMatch(def, init), { op: "endTurn" }, "2").state;
    expect(state.ctx).toMatchObject({ currentSeat: "1", turn: 2, activeSeats: ["1"] });
    expect(act(state, { op: "endTurn" }, "0").state.ctx.currentSeat).toBe("2");
    const view = viewFor(def, state, "0");
    expect(
      def
        .present(view, { components, seat: "0" })
        .hud?.filter((entry) => entry.active)
        .map((entry) => entry.seat),
    ).toEqual(["1"]);
  });
});

test("every invalid manual operation rejects atomically with INVALID_ARGS and a fixed message", () => {
  const state = createMatch(def, init);
  const coin = item(state, "market", 1).id;
  const privateItem = item(state, "hand:1").id;
  const invalidOps: unknown[] = [
    undefined,
    null,
    {},
    { op: "unknown" },
    { op: "move", item: "missing", to: "market" },
    { op: "move", item: coin, to: "missing" },
    { op: "move", item: coin, to: "market", index: 2 },
    { op: "move", item: coin, to: "market", index: -1 },
    { op: "move", item: coin, to: "table", pos_mm: [401, 0] },
    { op: "move", item: coin, to: "table", pos_mm: [0, -301] },
    { op: "move", item: coin, to: "table", pos_mm: [0.5, 0] },
    { op: "move", item: coin, to: "market", pos_mm: [0, 0] },
    { op: "move", item: privateItem, to: "market" },
    { op: "flip", item: "missing" },
    { op: "flip", item: privateItem },
    { op: "rotate", item: "missing", deg: 0 },
    { op: "rotate", item: privateItem, deg: 0 },
    { op: "rotate", item: coin, deg: -1 },
    { op: "rotate", item: coin, deg: 360 },
    { op: "rotate", item: coin, deg: 0.5 },
    { op: "shuffle", zone: "missing" },
    { op: "shuffle", zone: "hand:1" },
    { op: "deal", from: "missing", to: ["market"], count: 1 },
    { op: "deal", from: "deck", to: ["missing"], count: 1 },
    { op: "deal", from: "deck", to: [], count: 1 },
    { op: "deal", from: "deck", to: ["deck"], count: 1 },
    { op: "deal", from: "deck", to: ["market", "market"], count: 1 },
    { op: "deal", from: "deck", to: ["market"], count: 10 },
    { op: "deal", from: "deck", to: ["market"], count: 0 },
    { op: "deal", from: "hand:1", to: ["market"], count: 1 },
    { op: "roll", item: "missing" },
    { op: "roll", item: coin },
    { op: "roll", item: privateItem },
    { op: "endTurn", extra: true },
  ];
  const original = canonicalJson(state);
  for (const op of invalidOps) {
    const result = applyIntent(def, state, "0", {
      move: "manual",
      ...(op === undefined ? {} : { args: op as never }),
    });
    expect(result).toMatchObject({
      ok: false,
      code: "INVALID_ARGS",
      message:
        op === undefined || JsonSchema.safeParse(op).success
          ? "Invalid manual operation"
          : "Invalid arguments",
    });
    expect(canonicalJson(state)).toBe(original);
  }
  expect(applyIntent(def, state, "7", { move: "manual", args: { op: "endTurn" } })).toMatchObject({
    ok: false,
    code: "NOT_YOUR_TURN",
  });
});

test("views and snapshots enforce ownership, card backs, face-down identities and hidden die values", () => {
  let state = createMatch(def, init);
  const die = item(state, "market").id;
  state = act(state, { op: "move", item: die, to: "hand:1" }).state;
  state = act(state, { op: "deal", from: "deck", to: ["hand:1"], count: 2 }).state;
  for (const seat of [...init.seats, null]) {
    const view = viewFor(def, state, seat);
    const snapshot = def.present(view, { components, seat });
    expect(SandboxViewSchema.safeParse(view.game).success).toBe(true);
    expect(TableSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(
      sandboxSnapshotForSeatSchema(components, seat, (candidate) =>
        state.game.items.some(
          (item) =>
            item.id === candidate.id &&
            components.defs.some((def) => def.id === item.def && def.kind === "card"),
        ),
      ).safeParse(snapshot).success,
    ).toBe(true);
    for (const source of state.game.items) {
      const zone = components.zones?.find(
        (zone) => zone.id === source.zone || source.zone.startsWith(`${zone.id}:`),
      );
      const owner = source.zone.startsWith("hand:") ? source.zone.slice(5) : zone?.owner;
      const known = zone?.visibility === "owner" ? owner === seat : source.face === "up";
      const visible = view.game.items.find((candidate) => candidate.id === source.id);
      if (known) expect(visible?.def).toBe(source.def);
      else {
        expect(visible).not.toHaveProperty("def");
        expect(visible).not.toHaveProperty("value");
        expect(visible?.face).toBe("down");
      }
    }
    const privateDie = view.game.items.find((item) => item.id === die);
    expect(privateDie?.value).toBe(seat === "1" ? 1 : undefined);
    const otherHand = snapshot.items.find((item) => item.zone === "hand:1");
    expect(otherHand?.draggable).toBe(seat === "1");
    expect(snapshot.zones.map((zone) => zone.id)).toEqual([
      "deck",
      "market",
      "hand:0",
      "hand:1",
      "hand:2",
      "table",
      "grid",
    ]);
    expect(snapshot.zones.find((zone) => zone.id === "table")?.rect_mm).toEqual({
      x: 150,
      y: 0,
      w: 100,
      h: 100,
    });
    expect(snapshot.zones.find((zone) => zone.id === "grid")?.grid).toEqual({ cols: 2, rows: 2 });
    if (seat === null)
      expect(snapshot.items.every((item) => !item.draggable && !item.selectable)).toBe(true);
    expect(view).not.toHaveProperty("rng");
    const original = canonicalJson(view);
    def.present(view, { components, seat });
    expect(canonicalJson(view)).toBe(original);
  }
});

test("table size expands for declarations beyond the default table", () => {
  const file: ComponentsFile = {
    schemaVersion: 1,
    defs: [],
    setup: { instances: [] },
    zones: [
      {
        id: "far",
        layout: "free",
        rect_mm: { x: 500.2, y: -450.2, w: 100.2, h: 100.2 },
        visibility: "public",
      },
    ],
  };
  const local = createSandboxDefinition(file);
  const view = viewFor(local, createMatch(local, init), "0");
  const snapshot = local.present(view, { components: file, seat: "0" });
  expect(snapshot.table.size_mm).toEqual([1101, 1001]);
  expect(TableSnapshotSchema.safeParse(snapshot).success).toBe(true);
});

test("mixed manual operations replay identical state hashes at every step across seeds", {
  timeout: 120000,
}, async () => {
  for (let seed = 0; seed < 20; seed += 1) {
    const input = { ...init, seed };
    let state = createMatch(def, input);
    const random = createRandom(seedRandom(seed));
    const dealt = act(state, { op: "deal", from: "deck", to: ["hand:0", "hand:1"], count: 1 });
    const events: AcceptedEvent[] = [dealt.event];
    state = dealt.state;
    expect(await hashState(replay(def, input, events))).toBe(await hashState(state));
    for (let step = 0; step < 24; step += 1) {
      const die = item(state, "market").id;
      const ops: ManualOp[] = [
        { op: "shuffle", zone: "deck" },
        { op: "roll", item: die },
        { op: "rotate", item: die, deg: random.int(0, 359) },
        { op: "flip", item: die },
        { op: "endTurn" },
        {
          op: "move",
          item: item(state, "deck").id,
          to: "deck",
          index: random.int(0, state.game.items.filter((item) => item.zone === "deck").length - 1),
        },
      ];
      const result = act(state, random.pick(ops), random.pick(init.seats));
      events.push(result.event);
      state = result.state;
      expect(await hashState(replay(def, input, events))).toBe(await hashState(state));
    }
  }
});

test("shuffle removes rotation and free-position tracking marks from hidden items", () => {
  let state = createMatch(def, init);
  const card = item(state, "deck").id;
  state = act(state, { op: "move", item: card, to: "table", pos_mm: [390, 290] }).state;
  state = act(state, { op: "rotate", item: card, deg: 137 }).state;
  state = act(state, { op: "shuffle", zone: "table" }).state;
  for (const item of state.game.items.filter((item) => item.zone === "table")) {
    expect(item.rotation_deg).toBe(0);
    expect(item.pos_mm).toEqual([0, 0]);
    expect(item.id).not.toBe(card);
  }
});

test("setup shuffles each flagged zone once after all entries and supports fixed owners", () => {
  const file: ComponentsFile = {
    ...components,
    zones: [
      {
        id: "private",
        owner: "0",
        visibility: "owner",
        layout: "stack",
        rect_mm: { x: 0, y: 0, w: 100, h: 100 },
      },
    ],
    setup: {
      instances: [
        { def: "fish", zone: "private", count: 2, shuffle: true },
        { def: "tea", zone: "private", count: 2, shuffle: true },
      ],
    },
  };
  const local = createSandboxDefinition(file);
  const state = createMatch(local, init);
  const random = createRandom(seedRandom(init.seed));
  const originalIds = Array.from({ length: 4 }, () => random.id());
  random.shuffle(originalIds);
  const expectedIds = Array.from({ length: 4 }, () => random.id());
  expect(state.game.items.map((item) => item.id)).toEqual(expectedIds);
  expect(viewFor(local, state, "0").game.items.every((item) => item.def !== undefined)).toBe(true);
  expect(viewFor(local, state, "1").game.items.every((item) => item.def === undefined)).toBe(true);
});
