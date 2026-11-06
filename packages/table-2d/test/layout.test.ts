import type { ComponentsFile, ItemPlacement, TableSnapshot, ZonePlacement } from "@bgp/schema";
import { describe, expect, it } from "vitest";
import {
  dropGesture,
  fitViewport,
  focusOrder,
  hitItem,
  hitZone,
  keyboardDropTargets,
  layoutZone,
  screenToTable,
  tableToScreen,
} from "../src/layout.js";

const components: ComponentsFile = { schemaVersion: 1, defs: [] };
const items: ItemPlacement[] = [2, 0, 1].map((index) => ({
  id: `i${index}`,
  zone: "zone",
  index,
  face: "down",
  back: "back",
}));
function zone(layout: ZonePlacement["layout"]): ZonePlacement {
  return { id: "zone", layout, rect_mm: { x: 0, y: 0, w: 400, h: 200 } };
}

describe("zone layout", () => {
  it("draws the top of a stack with its count", () => {
    const result = layoutZone(zone("stack"), items, components);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ item: { id: "i2" }, count: 3, x: 0, y: 0 });
  });
  it("orders rows, centers them, and overlaps fans", () => {
    const row = layoutZone(zone("row"), items, components);
    const fan = layoutZone(zone("fan"), items, components);
    expect(row.map((p) => p.item.id)).toEqual(["i0", "i1", "i2"]);
    expect(row[0]?.x).toBeCloseTo(-(row[2]?.x ?? 0));
    expect(fan[0]?.rotation).toBe(-12);
    expect(fan[2]?.rotation).toBe(12);
    expect(Math.abs(fan[0]?.x ?? 0)).toBeLessThan(Math.abs(row[0]?.x ?? 0));
  });
  it("places grid cells left to right, then down", () => {
    const result = layoutZone({ ...zone("grid"), grid: { cols: 2, rows: 2 } }, items, components);
    expect(result.map(({ x, y }) => [x, y])).toEqual([
      [-100, 50],
      [100, 50],
      [-100, -50],
    ]);
  });
  it("preserves empty grid cells when items have sparse indices", () => {
    const sparse = [items[1] as ItemPlacement, { ...(items[2] as ItemPlacement), index: 3 }];
    const result = layoutZone({ ...zone("grid"), grid: { cols: 2, rows: 2 } }, sparse, components);
    expect(result.map(({ x, y }) => [x, y])).toEqual([
      [-100, 50],
      [100, -50],
    ]);
    // Inferred dimensions must include empty cells, too.
    expect(layoutZone(zone("grid"), sparse, components)).toEqual(result);
  });
  it("preserves absolute free coordinates and does not mutate input", () => {
    const source: ItemPlacement = {
      ...(items[0] as ItemPlacement),
      pos_mm: [17, -23],
      rotation_deg: 90,
    };
    expect(layoutZone(zone("free"), [source], components)[0]).toMatchObject({
      x: 17,
      y: -23,
      rotation: 90,
    });
    expect(items.map((item) => item.index)).toEqual([2, 0, 1]);
  });
  it("uses anonymous card dimensions regardless of other definitions", () => {
    const result = layoutZone(zone("row"), items, {
      schemaVersion: 1,
      defs: [{ id: "secret", kind: "die", sides: 6, size_mm: 200 }],
    });
    expect(result[0]).toMatchObject({ width: 63, height: 88 });
    expect(layoutZone(zone("row"), [], components)).toEqual([]);
  });
});

describe("drop coordinates", () => {
  const item: ItemPlacement = { id: "dragged", zone: "source", face: "up" };
  function snapshot(layout: ZonePlacement["layout"]): TableSnapshot {
    return {
      table: { size_mm: [799, 599] },
      zones: [
        {
          ...zone(layout),
          droppable: true,
          rect_mm: { x: 0, y: 0, w: 800, h: 600 },
          ...(layout === "grid" ? { grid: { cols: 4, rows: 3 } } : {}),
        },
      ],
      items: [],
    };
  }
  it("rounds and clamps to integer positions inside odd-sized tables", () => {
    expect(dropGesture(snapshot("free"), [], item, 399.9, 299.9)).toEqual({
      kind: "drop",
      item: "dragged",
      from: "source",
      to: "zone",
      pos_mm: [399, 299],
    });
  });
  it("uses the grid cell rather than counting items above the pointer", () => {
    expect(dropGesture(snapshot("grid"), [], item, 150, -30)).toMatchObject({ index: 6 });
    expect(dropGesture(snapshot("grid"), [], item, 400, -300)).toMatchObject({ index: 11 });
  });
  it("uses the same inferred sparse grid for rendering and dropping", () => {
    const table = snapshot("grid");
    table.zones = [{ ...zone("grid"), droppable: true }];
    table.items = [{ ...item, id: "occupied", zone: "zone", index: 3 }];
    const cell = layoutZone(table.zones[0] as ZonePlacement, table.items, components)[0];
    if (!cell) throw new Error("Missing sparse cell");
    expect(dropGesture(table, [cell], item, cell.x, cell.y)).toMatchObject({ index: 3 });
  });
  it("rejects drops outside zones or onto zones that do not accept them", () => {
    expect(dropGesture(snapshot("row"), [], item, 500, 0)).toBeUndefined();
    const blocked = snapshot("free");
    blocked.zones[0] = { ...zone("free"), droppable: false };
    expect(dropGesture(blocked, [], item, 0, 0)).toBeUndefined();
  });
  it("rotates a hand on the right to the bottom regardless of seat numbering", () => {
    const table = snapshot("free");
    table.zones = [{ ...zone("fan"), owner: "2", rect_mm: { x: 300, y: 0, w: 100, h: 100 } }];
    const view = fitViewport(table, 800, 800, "2");
    const [x, y] = tableToScreen(300, 0, view);
    expect(x).toBeCloseTo(400);
    expect(y).toBeGreaterThan(400);
  });
});

describe("coordinates and hit testing", () => {
  const snapshot: TableSnapshot = {
    table: { size_mm: [800, 600] },
    zones: [
      { ...zone("free"), owner: "0" },
      { ...zone("free"), id: "other", owner: "1" },
    ],
    items: [],
  };
  it.each([360, 1440])("fits width %i and reverses every viewing transformation", (width) => {
    for (const seat of [null, "0", "1"]) {
      const view = { ...fitViewport(snapshot, width, 700, seat), panX: 20, panY: -10 };
      const point = screenToTable(...tableToScreen(127, -93, view), view);
      expect(point[0]).toBeCloseTo(127);
      expect(point[1]).toBeCloseTo(-93);
      expect(view.scale * 800).toBeLessThanOrEqual(width - 24);
    }
  });
  it("maps positive table y up and clockwise rotation correctly", () => {
    const view = fitViewport(snapshot, 1000, 800, "0");
    expect(tableToScreen(0, 10, view)[1]).toBeLessThan(view.height / 2);
    expect(hitZone(snapshot, 0, 0)?.id).toBe("other");
    expect(hitZone(snapshot, 500, 0)).toBeUndefined();
    const placements = layoutZone(zone("row"), [items[0] as ItemPlacement], components);
    expect(hitItem(placements, 0, 0)?.item.id).toBe("i2");
    expect(hitItem(placements, 300, 300)).toBeUndefined();
  });
});

describe("rotated seat zones", () => {
  it.each([90, 180, 270])("rotates row cards and drop axes by %i degrees", (rotation_deg) => {
    const target = { ...zone("row"), rotation_deg, droppable: true };
    const placed = layoutZone(target, items, components);
    const original = layoutZone(zone("row"), items, components);
    const angle = (rotation_deg * Math.PI) / 180;
    const snapshot: TableSnapshot = { table: { size_mm: [900, 900] }, zones: [target], items };
    for (const [i, p] of placed.entries()) {
      const source = original[i];
      if (!source) throw new Error("Missing placement");
      expect(p.x).toBeCloseTo(source.x * Math.cos(angle));
      expect(p.y).toBeCloseTo(-source.x * Math.sin(angle));
      expect(p.rotation).toBe(rotation_deg);
      expect(hitZone(snapshot, p.x, p.y)?.id).toBe("zone");
    }
    const incoming: ItemPlacement = { id: "incoming", zone: "hand", face: "down", back: "back" };
    expect(
      dropGesture(snapshot, placed, incoming, 35 * Math.cos(angle), -35 * Math.sin(angle)),
    ).toMatchObject({ index: 2 });
  });
  it("uses rotated rectangles and grid cells for hit testing", () => {
    const target = {
      ...zone("grid"),
      grid: { cols: 2, rows: 2 },
      rotation_deg: 90,
      droppable: true,
    };
    const snapshot: TableSnapshot = { table: { size_mm: [900, 900] }, zones: [target], items };
    expect(hitZone(snapshot, 150, 0)).toBeUndefined();
    expect(hitZone(snapshot, 0, 150)?.id).toBe("zone");
    const incoming: ItemPlacement = { id: "incoming", zone: "hand", face: "down", back: "back" };
    expect(dropGesture(snapshot, [], incoming, -50, -100)).toMatchObject({ index: 3 });
  });
  it("rotates fan positions and angles but keeps free item coordinates absolute", () => {
    const fan = layoutZone({ ...zone("fan"), rotation_deg: 90 }, items, components);
    expect(fan[0]?.rotation).toBe(78);
    expect(fan[0]?.y).toBeGreaterThan(0);
    const item: ItemPlacement = {
      id: "free",
      zone: "zone",
      face: "down",
      back: "back",
      pos_mm: [17, 23],
      rotation_deg: 12,
    };
    expect(layoutZone({ ...zone("free"), rotation_deg: 90 }, [item], components)[0]).toMatchObject({
      x: 17,
      y: 23,
      rotation: 12,
    });
  });
});

describe("keyboard focus order", () => {
  const table: TableSnapshot = {
    table: { size_mm: [800, 600] },
    zones: [
      { id: "hand", layout: "row", owner: "0", rect_mm: { x: 0, y: -220, w: 400, h: 120 } },
      { id: "deck", layout: "stack", rect_mm: { x: -200, y: 100, w: 120, h: 120 } },
      { id: "market", layout: "row", rect_mm: { x: 100, y: 100, w: 300, h: 120 } },
      { id: "far", layout: "row", owner: "1", rect_mm: { x: 0, y: 230, w: 400, h: 120 } },
    ],
    items: [
      { id: "h0", zone: "hand", index: 0, face: "down" },
      { id: "h1", zone: "hand", index: 1, face: "down" },
      { id: "d0", zone: "deck", index: 0, face: "down" },
      { id: "d1", zone: "deck", index: 1, face: "down" },
      { id: "m0", zone: "market", index: 0, face: "down" },
      { id: "m1", zone: "market", index: 1, face: "down" },
      { id: "f0", zone: "far", index: 0, face: "down" },
    ],
  };
  const placements = table.zones.flatMap((z) => layoutZone(z, table.items, components));
  it("reads the table top to bottom, then left to right, for the viewing seat", () => {
    const view = fitViewport(table, 1000, 800, "0");
    expect(focusOrder(table, placements, view)).toEqual(["f0", "d1", "m0", "m1", "h0", "h1"]);
  });
  it("follows the rotated view of the seat across the table", () => {
    const view = fitViewport(table, 1000, 800, "1");
    expect(focusOrder(table, placements, view)).toEqual(["h1", "h0", "m1", "m0", "d1", "f0"]);
  });
});

describe("keyboard drag and drop targets", () => {
  const table: TableSnapshot = {
    table: { size_mm: [801, 601] },
    zones: [
      {
        id: "hand",
        layout: "row",
        owner: "0",
        droppable: true,
        rect_mm: { x: 0, y: -220, w: 400, h: 120 },
      },
      {
        id: "deck",
        layout: "stack",
        droppable: true,
        rect_mm: { x: -200, y: 100, w: 120, h: 120 },
      },
      { id: "market", layout: "row", droppable: true, rect_mm: { x: 100, y: 100, w: 300, h: 120 } },
      { id: "board", layout: "free", droppable: true, rect_mm: { x: 250, y: -120, w: 101, h: 61 } },
      { id: "far", layout: "row", owner: "1", rect_mm: { x: 0, y: 230, w: 400, h: 120 } },
    ],
    items: [
      { id: "h0", zone: "hand", index: 0, face: "up", draggable: true },
      { id: "h1", zone: "hand", index: 1, face: "up", draggable: true },
      { id: "d0", zone: "deck", index: 0, face: "down" },
      { id: "d1", zone: "deck", index: 1, face: "down" },
      { id: "m0", zone: "market", index: 0, face: "up" },
      { id: "m1", zone: "market", index: 1, face: "up" },
      { id: "f0", zone: "far", index: 0, face: "down" },
    ],
  };
  const placements = table.zones.flatMap((z) => layoutZone(z, table.items, components));
  const view = fitViewport(table, 1000, 800, "0");
  const carried = table.items[0] as ItemPlacement;
  const targets = keyboardDropTargets(table, placements, carried, view);

  it("offers every piece of a row and the end of every droppable zone, in focus order", () => {
    expect(targets.map((target) => [target.gesture.to, target.at ?? null])).toEqual([
      ["deck", null],
      ["market", "m0"],
      ["market", "m1"],
      ["market", null],
      ["board", null],
      ["hand", "h1"],
      ["hand", null],
    ]);
  });

  it("gives the same gesture as a pointer dropped on the piece", () => {
    const market = placements.find((p) => p.item.id === "m1");
    if (!market) throw new Error("Missing m1");
    const pointer = dropGesture(table, placements, carried, market.x, market.y);
    expect(targets[2]?.gesture).toEqual(pointer);
    expect(targets[2]?.gesture).toEqual({
      kind: "drop",
      item: "h0",
      from: "hand",
      to: "market",
      index: 1,
    });
  });

  it("drops on top of a stack, after the last piece of a row, and at a free zone's centre", () => {
    expect(targets[0]?.gesture).toMatchObject({ to: "deck", index: 2 });
    expect(targets[3]?.gesture).toMatchObject({ to: "market", index: 2 });
    expect(targets[4]?.gesture).toEqual({
      kind: "drop",
      item: "h0",
      from: "hand",
      to: "board",
      pos_mm: [250, -120],
    });
    // Within its own row the piece's own place is not a target; the end is, after the others.
    expect(targets[6]?.gesture).toMatchObject({ to: "hand", index: 1 });
  });

  it("offers nothing when no zone accepts drops", () => {
    const closed = { ...table, zones: table.zones.map((z) => ({ ...z, droppable: false })) };
    expect(keyboardDropTargets(closed, placements, carried, view)).toEqual([]);
  });
});
