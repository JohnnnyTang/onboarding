import type { ClientView, ComponentsFile, Json } from "@bgp/schema";
import { describe, expect, it } from "vitest";
import { checkStep, SeenMemory, stateInstances } from "../src/leak-check.js";

const components: ComponentsFile = {
  schemaVersion: 1,
  defs: [
    { id: "back", kind: "cardBack", image: "assets/back.png" },
    { id: "fish", kind: "card", size_mm: [63, 88], front: "assets/fish.png", back: "back" },
    { id: "salt", kind: "card", size_mm: [63, 88], front: "assets/salt.png", back: "back" },
  ],
  zones: [
    {
      id: "hand",
      layout: "fan",
      rect_mm: { x: 0, y: 200, w: 300, h: 100 },
      owner: "each",
      visibility: "owner",
    },
  ],
};

const ctx = {
  seats: ["0", "1"],
  currentSeat: "0",
  activeSeats: ["0"],
  phase: "main",
  turn: 1,
  moveNumber: 0,
  options: {},
};

function view(game: Json): ClientView {
  return { ctx, game, result: null };
}

function table(items: object[]) {
  return {
    table: { size_mm: [800, 800] },
    zones: [
      { id: "hand:0", layout: "fan", rect_mm: { x: 0, y: 200, w: 300, h: 100 } },
      { id: "hand:1", layout: "fan", rect_mm: { x: 0, y: -200, w: 300, h: 100 } },
      { id: "pile", layout: "stack", rect_mm: { x: 0, y: 0, w: 80, h: 100 } },
    ],
    items,
  };
}

const up = (id: string, zone: string, def: string) => ({ id, zone, face: "up", def });
const down = (id: string, zone: string) => ({ id, zone, face: "down", back: "back" });

/** Full state: seat 0 holds card a (fish), seat 1 holds card b (salt). */
const game: Json = { cards: { a: { kind: "fish" }, b: { kind: "salt" } }, hands: [["a"], ["b"]] };

function outputs(views: [Json, Json, Json]) {
  return [
    {
      seat: "0",
      view: view(views[0]),
      snapshot: table([up("a", "hand:0", "fish"), down("x1", "hand:1")]),
    },
    {
      seat: "1",
      view: view(views[1]),
      snapshot: table([down("x0", "hand:0"), up("b", "hand:1", "salt")]),
    },
    {
      seat: null,
      view: view(views[2]),
      snapshot: table([down("x0", "hand:0"), down("x1", "hand:1")]),
    },
  ];
}

describe("checkStep", () => {
  it("accepts views that carry only what each seat sees", () => {
    const problems = checkStep(
      components,
      game,
      outputs([{ hand: [{ id: "a", kind: "fish" }] }, { hand: [{ id: "b", kind: "salt" }] }, {}]),
      new SeenMemory(),
    );
    expect(problems).toEqual([]);
  });

  it("flags another seat's card carried in a view", () => {
    const problems = checkStep(
      components,
      game,
      outputs([{ hand: [{ id: "a", kind: "fish" }], other: [{ id: "b", kind: "salt" }] }, {}, {}]),
      new SeenMemory(),
    );
    // Both the instance and its definition name ("salt") give it away.
    expect(problems).toEqual([
      expect.objectContaining({ seat: "0", message: expect.stringContaining('instance "b"') }),
      expect.objectContaining({ seat: "0", message: expect.stringContaining('names "salt"') }),
    ]);
  });

  it("flags a definition named in a view that the seat never saw", () => {
    const problems = checkStep(
      components,
      game,
      outputs([{}, {}, { secret: "fish" }]),
      new SeenMemory(),
    );
    expect(problems).toEqual([
      expect.objectContaining({ seat: null, message: expect.stringContaining('names "fish"') }),
    ]);
  });

  it("accepts public history the table no longer draws", () => {
    const memory = new SeenMemory();
    expect(checkStep(components, game, outputs([{}, {}, {}]), memory)).toEqual([]);
    // Seat 0 discards card a: now nobody's table shows it, but seat 0 saw it, so others may
    // learn it from a public discard pile.
    const later = outputs([
      { discard: [{ id: "a", kind: "fish" }] },
      { discard: [{ id: "a", kind: "fish" }] },
      {},
    ]);
    for (const output of later) {
      output.snapshot = table(output.seat === "1" ? [up("b", "hand:1", "salt")] : []);
    }
    expect(checkStep(components, game, later, memory)).toEqual([]);
  });

  it("flags a card face up in another seat's owner zone", () => {
    const steps = outputs([{}, {}, {}]);
    const [, seat1] = steps;
    if (seat1) seat1.snapshot = table([up("a", "hand:0", "fish"), up("b", "hand:1", "salt")]);
    expect(checkStep(components, game, steps, new SeenMemory())).toEqual([
      expect.objectContaining({
        seat: "1",
        message: expect.stringContaining("owner zone face up"),
      }),
    ]);
  });

  it("indexes id fields and id-keyed records, but not seats", () => {
    const instances = stateInstances({
      deck: [{ id: "c", value: 3 }],
      cards: { d: { value: 4 } },
      players: { "0": { score: 1 } },
    });
    expect([...instances.keys()].sort()).toEqual(["c", "d"]);
  });
});
