import type { TableSnapshot } from "@bgp/schema";
import { ComponentsFileSchema, TableSnapshotSchema } from "@bgp/schema";

export const components = ComponentsFileSchema.parse({
  schemaVersion: 1,
  defs: [
    { id: "back", kind: "cardBack", image: "assets/back.png" },
    {
      id: "fish",
      kind: "card",
      name: "FISH",
      size_mm: [63, 88],
      front: "assets/fish.png",
      back: "back",
    },
    {
      id: "missing",
      kind: "card",
      name: "Missing art",
      size_mm: [63, 88],
      front: "assets/missing.png",
      back: "back",
    },
    {
      id: "coin",
      kind: "token",
      name: "COIN",
      shape: "circle",
      size_mm: [30, 30],
      front: "assets/coin.png",
      back: "assets/back.png",
    },
    {
      id: "hex",
      kind: "token",
      name: "HEX",
      shape: "hex",
      size_mm: [32, 32],
      front: "assets/missing.png",
    },
    {
      id: "square",
      kind: "token",
      name: "SQUARE",
      shape: "square",
      size_mm: [28, 28],
      front: "assets/missing.png",
    },
    {
      id: "rect",
      kind: "token",
      name: "RECT",
      shape: "rect",
      size_mm: [40, 25],
      front: "assets/missing.png",
    },
    {
      id: "die",
      kind: "die",
      name: "Die",
      sides: 6,
      size_mm: 38,
      color: "#ecd7a8",
      faces: ["1", "2", "3", "4", "5", "6"],
    },
    { id: "board", kind: "board", name: "Harbor", size_mm: [120, 65], image: "assets/board.png" },
    { id: "piece", kind: "piece", name: "Boat", size_mm: [42, 35, 20], image: "assets/piece.png" },
    {
      id: "small",
      kind: "card",
      name: "Cargo",
      size_mm: [28, 36],
      front: "assets/fish.png",
      back: "back",
    },
  ],
});

export const fixture = TableSnapshotSchema.parse({
  table: { size_mm: [800, 600] },
  zones: [
    {
      id: "deck",
      label: "STACK / 12",
      layout: "stack",
      rect_mm: { x: -280, y: 100, w: 130, h: 140 },
      droppable: true,
    },
    {
      id: "market",
      label: "ROW / MARKET",
      layout: "row",
      rect_mm: { x: 80, y: 100, w: 540, h: 140 },
      droppable: true,
    },
    {
      id: "grid",
      label: "GRID / SUPPLY",
      layout: "grid",
      rect_mm: { x: -230, y: -60, w: 220, h: 180 },
      grid: { cols: 3, rows: 2 },
      droppable: true,
    },
    {
      id: "free",
      label: "FREE / DROP HERE",
      layout: "free",
      rect_mm: { x: 150, y: -60, w: 380, h: 180 },
      droppable: true,
    },
    {
      id: "hand",
      label: "FAN / YOUR HAND",
      owner: "0",
      layout: "fan",
      rect_mm: { x: 0, y: -220, w: 440, h: 140 },
      droppable: true,
    },
    {
      id: "opponent",
      label: "SEAT 1",
      owner: "1",
      layout: "fan",
      rect_mm: { x: 0, y: 235, w: 400, h: 130 },
    },
  ],
  items: [
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `deck-${index}`,
      zone: "deck",
      index,
      face: "down",
      back: "back",
      draggable: true,
    })),
    ...["fish", "fish", "missing", "fish", "fish"].map((def, index) => ({
      id: `market-${index}`,
      zone: "market",
      index,
      def,
      face: "up",
      selectable: true,
      draggable: true,
      ...(index === 0
        ? { highlight: "legal", badge: "2" }
        : index === 4
          ? { highlight: "warning" }
          : {}),
    })),
    ...["coin", "die", "hex", "square", "rect"].map((def, index) => ({
      id: `supply-${index}`,
      zone: "grid",
      index,
      def,
      face: "up",
      value: 5,
      selectable: true,
      draggable: true,
    })),
    { id: "board", zone: "free", def: "board", face: "up", pos_mm: [100, -60] },
    {
      id: "boat",
      zone: "free",
      def: "piece",
      face: "up",
      pos_mm: [260, -60],
      rotation_deg: 30,
      draggable: true,
      selectable: true,
    },
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `hand-${index}`,
      zone: "hand",
      index,
      def: "fish",
      face: "up",
      selectable: true,
      draggable: true,
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `other-${index}`,
      zone: "opponent",
      index,
      face: "down",
      back: "back",
    })),
  ],
  prompt: "Select cargo or drag a card to the table.",
  hud: [
    { seat: "0", name: "You", score: 7, handCount: 5, active: true },
    { seat: "1", name: "Guest", score: 4, handCount: 4, active: false },
  ],
});

export const stressFixture: TableSnapshot = TableSnapshotSchema.parse({
  table: { size_mm: [1000, 750] },
  zones: [
    {
      id: "cargo",
      label: "300 draggable items",
      layout: "grid",
      rect_mm: { x: 0, y: 0, w: 960, h: 700 },
      grid: { cols: 20, rows: 15 },
      droppable: true,
    },
  ],
  items: Array.from({ length: 300 }, (_, index) => ({
    id: `cargo-${index}`,
    zone: "cargo",
    index,
    def: "small",
    face: "up",
    draggable: true,
    selectable: true,
  })),
});

export function fixtureAssets(): (ref: string) => string {
  const assets = new Map<string, string>();
  for (const [ref, title, color] of [
    ["fish", "FISH", "#d49a64"],
    ["back", "BGP", "#35576b"],
    ["coin", "1", "#e0b556"],
    ["board", "HARBOR", "#639f9e"],
    ["piece", "BOAT", "#bd7154"],
  ]) {
    const canvas = document.createElement("canvas");
    canvas.width = 126;
    canvas.height = 176;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable");
    ctx.fillStyle = color ?? "#333";
    ctx.fillRect(0, 0, 126, 176);
    ctx.strokeStyle = "#f4e9cf";
    ctx.lineWidth = 2;
    ctx.strokeRect(8, 8, 110, 160);
    ctx.fillStyle = "#f4e9cf";
    ctx.font = "bold 20px Arial";
    ctx.textAlign = "center";
    ctx.fillText(title ?? "", 63, 96);
    assets.set(`assets/${ref}.png`, canvas.toDataURL("image/png"));
  }
  return (ref) => assets.get(ref) ?? "/dev/table/missing.png";
}
