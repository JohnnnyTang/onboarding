import { describe, expect, test } from "vitest";
import {
  CARD_FONT_IDS,
  CardFontSchema,
  type CardTemplate,
  CardTemplateSchema,
  type CsvSource,
  CsvSourceSchema,
  LocalProjectSchema,
} from "../src/index.js";
import { components, manifest } from "./fixtures.js";

const SOURCE_ID = "0192f3a4-5b6c-7d8e-9f01-23456789abd0";

const source: CsvSource = {
  id: SOURCE_ID,
  name: "goods.csv",
  columns: ["id", "name", "color"],
  rows: [
    ["fish-1", "Fish 1", "#2f6fb0"],
    ["salt-1", "Salt 1", "#8a8f98"],
  ],
  importedAt: "2026-11-04T10:00:00.000Z",
};

const template: CardTemplate = {
  id: "goods",
  name: "Goods",
  size_mm: [63.5, 88],
  background: "#fff",
  fields: [
    {
      id: "frame",
      label: "Frame",
      kind: "box",
      rect_mm: { x: 0, y: 0, w: 63.5, h: 88 },
      color: "#2f6fb0",
      radius_mm: 3,
    },
    {
      id: "title",
      label: "Title",
      kind: "text",
      rect_mm: { x: 4, y: 3.5, w: 55, h: 10 },
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
      image: "assets/fish.png",
      fit: "contain",
    },
  ],
  back: null,
  data: {
    source: SOURCE_ID,
    columns: { frame: "color", title: "name" },
    idColumn: "id",
    nameColumn: "name",
    countColumn: null,
  },
  generated: ["fish-1"],
};

describe("card templates", () => {
  test("accept decimal millimeters, every field kind and a column mapping", () => {
    expect(CardTemplateSchema.parse(template)).toEqual(template);
  });

  test.each([
    ["a named color", { ...template, background: "white" }],
    ["a zero-size card", { ...template, size_mm: [0, 88] }],
    ["duplicate field ids", { ...template, fields: [template.fields[0], template.fields[0]] }],
    [
      "a mapping to a missing field",
      { ...template, data: { ...template.data, columns: { x: "id" } } },
    ],
    ["an SVG image", { ...template, fields: [{ ...template.fields[2], image: "assets/a.svg" }] }],
    [
      "a negative position",
      { ...template, fields: [{ ...template.fields[0], rect_mm: { x: -1, y: 0, w: 1, h: 1 } }] },
    ],
    ["an unknown field kind", { ...template, fields: [{ ...template.fields[0], kind: "line" }] }],
    ["duplicate generated ids", { ...template, generated: ["a", "a"] }],
    ["an unknown property", { ...template, extra: true }],
    [
      "a font that is not bundled",
      { ...template, fields: [{ ...template.fields[1], font: "comic-sans" }] },
    ],
  ])("reject %s", (_name, value) => {
    expect(CardTemplateSchema.safeParse(value).success).toBe(false);
  });
});

test("text fields accept every bundled font and the generic aliases", () => {
  for (const font of CardFontSchema.options) {
    const fields = template.fields.map((field) =>
      field.kind === "text" ? { ...field, font } : field,
    );
    expect(CardTemplateSchema.safeParse({ ...template, fields }).success).toBe(true);
  }
  expect(CardFontSchema.options).toEqual([...CARD_FONT_IDS, "sans-serif", "serif", "monospace"]);
});

describe("CSV sources", () => {
  test("accept a header and rows of text cells", () => {
    expect(CsvSourceSchema.parse(source)).toEqual(source);
  });

  test.each([
    ["duplicate columns", { ...source, columns: ["id", "id", "color"] }],
    ["an empty column name", { ...source, columns: ["id", "", "color"] }],
    ["a short row", { ...source, rows: [["fish-1"]] }],
    ["a number cell", { ...source, rows: [["fish-1", "Fish 1", 3]] }],
  ])("reject %s", (_name, value) => {
    expect(CsvSourceSchema.safeParse(value).success).toBe(false);
  });
});

describe("projects with card data", () => {
  const { entry: _entry, ...base } = manifest;
  const project = {
    id: "0192f3a4-5b6c-7d8e-9f01-23456789abcd",
    name: manifest.name,
    mode: "sandbox",
    manifest: { ...base, mode: "sandbox" },
    components,
    cardTemplates: [template],
    csvSources: [source],
    updatedAt: "2026-11-04T10:00:00.000Z",
    publishedVersionIds: [],
  };

  test("accept a template that names one of the project's sources", () => {
    expect(LocalProjectSchema.parse(project)).toEqual(project);
  });

  test("reject a template naming a source the project lacks", () => {
    expect(LocalProjectSchema.safeParse({ ...project, csvSources: [] }).success).toBe(false);
  });

  test("reject duplicate template ids", () => {
    expect(
      LocalProjectSchema.safeParse({ ...project, cardTemplates: [template, template] }).success,
    ).toBe(false);
  });
});
