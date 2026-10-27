import { describe, expect, test } from "vitest";
import {
  ComponentsFileSchema,
  componentAssetRefs,
  DieDefSchema,
  GestureSchema,
  ImageAssetRefSchema,
  ManualOpSchema,
  SandboxStateSchema,
  sandboxSnapshotForSeatSchema,
  TableSnapshotSchema,
  tableSnapshotForSeatSchema,
} from "../src/index.js";
import { components, snapshot } from "./fixtures.js";

describe("components, snapshots and gestures", () => {
  test("standalone die declarations reject SVG faces", () => {
    expect(
      DieDefSchema.safeParse({
        id: "die",
        kind: "die",
        sides: 4,
        size_mm: 16,
        faces: ["assets/front.svg", "2", "3", "4"],
      }).success,
    ).toBe(false);
  });
  test("supports every component kind, fractional declarations and expanded setup zones", () => {
    expect(ComponentsFileSchema.parse(components)).toEqual(components);
    expect(
      ComponentsFileSchema.parse({
        ...components,
        setup: { instances: [{ def: "fish", zone: "hand:0" }] },
      }),
    ).toBeDefined();
    expect(TableSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(componentAssetRefs(ComponentsFileSchema.parse(components))).toContain("assets/pawn.glb");
  });
  test.each([
    { ...components, defs: [...components.defs, components.defs[0]] },
    {
      ...components,
      defs: [
        { id: "card", kind: "card", size_mm: [63, 88], front: "assets/front.png", back: "missing" },
      ],
    },
    { ...components, defs: [{ id: "die", kind: "die", sides: 6, size_mm: 16, faces: ["one"] }] },
    {
      ...components,
      defs: [
        {
          id: "die",
          kind: "die",
          sides: 6,
          size_mm: 16,
          faces: ["a.svg", "2", "3", "4", "5", "6"],
        },
      ],
    },
    { ...components, setup: { instances: [{ def: "unknown", zone: "market" }] } },
    { ...components, setup: { instances: [{ def: "fish", zone: "hand:not-a-seat" }] } },
    {
      ...components,
      zones: [
        { id: "hand", layout: "fan", rect_mm: { x: 0, y: 0, w: 100, h: 100 }, visibility: "owner" },
      ],
    },
  ])("rejects invalid component declarations %#", (value) => {
    expect(ComponentsFileSchema.safeParse(value).success).toBe(false);
  });
  test.each([
    "assets/card.svg",
    "assets/card.SVG",
    "https://host/card.png",
    "../card.png",
    "/card.png",
    "assets\\card.png",
    "assets/card.png?svg",
  ])("rejects unsafe image %s", (asset) => {
    expect(ImageAssetRefSchema.safeParse(asset).success).toBe(false);
  });
  test.each([
    { ...snapshot, items: [{ id: "i1", zone: "market", face: "up", pos_mm: [0.1, 0] }] },
    { ...snapshot, items: [{ id: "i1", zone: "market", face: "up", rotation_deg: 360 }] },
    { ...snapshot, items: [{ id: "i1", zone: "market", face: "up", pos_mm: [401, 0] }] },
    { ...snapshot, items: [{ id: "i1", zone: "hand:0", face: "up", pos_mm: [0, 0] }] },
    { ...snapshot, items: [{ id: "i1", zone: "unknown", face: "up" }] },
    { ...snapshot, items: [snapshot.items[0], snapshot.items[0]] },
  ])("rejects invalid snapshots %#", (value) => {
    expect(TableSnapshotSchema.safeParse(value).success).toBe(false);
  });
  test("hidden-item validation follows seat visibility, including spectators and public face-down items", () => {
    const parsed = ComponentsFileSchema.parse(components);
    const identified = { id: "i123", zone: "hand:0", face: "down", def: "fish" };
    const hidden = { id: "i123", zone: "hand:0", face: "down", back: "back" };
    expect(
      sandboxSnapshotForSeatSchema(parsed, "0").safeParse({ ...snapshot, items: [identified] })
        .success,
    ).toBe(true);
    for (const seat of ["1", null]) {
      const schema = sandboxSnapshotForSeatSchema(parsed, seat, () => true);
      expect(schema.safeParse({ ...snapshot, items: [identified] }).success).toBe(false);
      expect(schema.safeParse({ ...snapshot, items: [hidden] }).success).toBe(true);
      expect(
        schema.safeParse({ ...snapshot, items: [{ ...hidden, back: undefined }] }).success,
      ).toBe(false);
    }
    expect(
      sandboxSnapshotForSeatSchema(parsed, "0").safeParse({
        ...snapshot,
        items: [{ ...identified, zone: "market" }],
      }).success,
    ).toBe(false);
    expect(
      tableSnapshotForSeatSchema({ components: parsed, canIdentify: () => false }).safeParse(
        snapshot,
      ).success,
    ).toBe(false);
    expect(
      tableSnapshotForSeatSchema({ components: parsed, canIdentify: () => true }).safeParse({
        ...snapshot,
        items: [{ ...identified, def: "missing" }],
      }).success,
    ).toBe(false);
  });
  test.each([
    { kind: "click", item: "i1" },
    { kind: "clickZone", zone: "market" },
    { kind: "drop", item: "i1", from: "hand:0", to: "market", pos_mm: [10, -10], index: 0 },
  ])("accepts gesture %#", (value) => {
    expect(GestureSchema.parse(value)).toEqual(value);
  });
  test.each([
    { op: "move", item: "i1", to: "market", index: 0, pos_mm: [-20, 30], face: "up" },
    { op: "flip", item: "i1" },
    { op: "rotate", item: "i1", deg: 359 },
    { op: "shuffle", zone: "deck" },
    { op: "deal", from: "deck", to: ["hand:0", "hand:1"], count: 3 },
    { op: "roll", item: "i2" },
    { op: "endTurn" },
  ])("accepts manual operation %#", (value) => {
    expect(ManualOpSchema.parse(value)).toEqual(value);
  });
  test.each([
    { op: "rotate", item: "i1", deg: -1 },
    { op: "rotate", item: "i1", deg: 0.5 },
    { op: "deal", from: "deck", to: [], count: 1 },
    { op: "deal", from: "deck", to: ["hand:0"], count: 0 },
    { op: "flip", item: "i1", def: "fish" },
    { op: "invented" },
  ])("rejects invalid manual operation %#", (value) => {
    expect(ManualOpSchema.safeParse(value).success).toBe(false);
  });
  test("sandbox authoritative state rejects undefined and fractional positions", () => {
    const item = { id: "i1", def: "fish", zone: "market", index: 0, rotation_deg: 0, face: "up" };
    expect(SandboxStateSchema.parse({ items: [item] })).toBeDefined();
    expect(SandboxStateSchema.safeParse({ items: [{ ...item, pos_mm: undefined }] }).success).toBe(
      false,
    );
    expect(SandboxStateSchema.safeParse({ items: [{ ...item, pos_mm: [0, 0.5] }] }).success).toBe(
      false,
    );
  });
});
