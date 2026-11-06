import type { TableSnapshot } from "@bgp/schema";
import { describe, expect, it } from "vitest";
import { mergeSnapshots } from "./merge-snapshots";

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
