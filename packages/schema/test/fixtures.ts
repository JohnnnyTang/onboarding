export const ctx = {
  seats: ["0", "1"],
  currentSeat: "0",
  activeSeats: ["0"],
  phase: "main",
  turn: 1,
  moveNumber: 0,
  options: {},
};
export const view = { ctx, game: { hand: ["i123"], deckCount: 4 }, result: null };
export const state = { v: 1, game: { cards: ["i123"] }, ctx, rng: [1, 2, 3, 4], result: null };
export const manifest = {
  schemaVersion: 1,
  id: "harbor-market",
  name: "Harbor Market",
  version: "0.1.0",
  mode: "enforced",
  sdk: 1,
  players: { min: 2, max: 4 },
  entry: "dist/game.js",
  components: "components.json",
};
export const components = {
  schemaVersion: 1,
  defs: [
    { id: "back", kind: "cardBack", image: "assets/back.png" },
    {
      id: "fish",
      kind: "card",
      size_mm: [63, 88],
      thickness_mm: 0.3,
      front: "assets/fish.png",
      back: "back",
    },
    { id: "coin", kind: "token", shape: "circle", size_mm: [20, 20], front: "assets/coin.webp" },
    { id: "die", kind: "die", sides: 6, size_mm: 16, faces: ["1", "2", "3", "4", "5", "6"] },
    { id: "board", kind: "board", size_mm: [400, 300], image: "assets/board.avif" },
    {
      id: "pawn",
      kind: "piece",
      size_mm: [12, 12, 30],
      image: "assets/pawn.jpg",
      model: "assets/pawn.glb",
    },
  ],
  zones: [
    { id: "market", layout: "free", rect_mm: { x: 0, y: 0, w: 300, h: 200 }, visibility: "public" },
    {
      id: "hand",
      layout: "fan",
      rect_mm: { x: 0, y: -150, w: 250, h: 100 },
      owner: "each",
      visibility: "owner",
    },
  ],
  setup: { instances: [{ def: "fish", zone: "market", count: 10, face: "down", shuffle: true }] },
};
export const snapshot = {
  table: { size_mm: [800, 600] },
  zones: [
    { id: "market", layout: "free", rect_mm: { x: 0, y: 0, w: 300, h: 200 } },
    { id: "hand:0", layout: "fan", rect_mm: { x: 0, y: -150, w: 250, h: 100 }, owner: "0" },
    { id: "hand:1", layout: "fan", rect_mm: { x: 0, y: 150, w: 250, h: 100 }, owner: "1" },
  ],
  items: [{ id: "i123", zone: "market", face: "up", def: "fish", pos_mm: [0, 0] }],
};
export const seatInfo = { seat: "0", name: "Designer", connected: true, guest: false };
export const hash = "ab".repeat(32);
export const match = {
  id: "match-1",
  status: "active",
  versionId: "version-1",
  buildHash: hash,
  seats: [seatInfo],
};
