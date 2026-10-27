import type { ComponentsFile, ItemPlacement, TableSnapshot, ZonePlacement } from "@bgp/schema";
import { describe, expect, it } from "vitest";
import {
  dropGesture,
  fitViewport,
  hitItem,
  hitZone,
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
