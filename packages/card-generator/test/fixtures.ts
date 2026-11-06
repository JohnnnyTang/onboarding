import type { CardTemplate, CsvSource } from "@bgp/schema";

export const template: CardTemplate = {
  id: "goods",
  name: "Goods",
  size_mm: [63, 88],
  background: "#ffffff",
  fields: [
    {
      id: "frame",
      label: "Frame",
      kind: "box",
      rect_mm: { x: 0, y: 0, w: 63, h: 88 },
      color: "#2f6fb0",
      radius_mm: 3,
    },
    {
      id: "title",
      label: "Title",
      kind: "text",
      rect_mm: { x: 4, y: 3, w: 55, h: 10 },
      text: "Good",
      size_mm: 6,
      color: "#ffffff",
      font: "serif",
      bold: true,
      align: "center",
      valign: "middle",
    },
    {
      id: "art",
      label: "Art",
      kind: "image",
      rect_mm: { x: 4, y: 14, w: 55, h: 60 },
      image: null,
      fit: "contain",
    },
  ],
  back: null,
  data: {
    source: "0192f3a4-5b6c-7d8e-9f01-23456789abd0",
    columns: { frame: "color", title: "name", art: "art" },
    idColumn: "id",
    nameColumn: "name",
    countColumn: "copies",
  },
  generated: [],
};

export const source: CsvSource = {
  id: "0192f3a4-5b6c-7d8e-9f01-23456789abd0",
  name: "goods.csv",
  columns: ["id", "name", "color", "art", "copies"],
  rows: [
    ["Fish 1", "Fish 1", "#2f6fb0", "fish", "4"],
    ["salt-1", "Salt 1", "blue", "salt.png", "x"],
    ["", "", "", "", "2"],
  ],
  importedAt: "2026-11-04T10:00:00.000Z",
};

export const IMAGES = ["assets/fish.png", "assets/Salt.PNG", "assets/cards/fish-1.png"];
