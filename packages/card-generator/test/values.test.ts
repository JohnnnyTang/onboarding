import { describe, expect, test } from "vitest";
import {
  cardSlug,
  defaultValues,
  findImage,
  missingColumns,
  planCards,
  rowValues,
} from "../src/index.js";
import { IMAGES, source, template } from "./fixtures.js";

describe("cell values", () => {
  test("images are found by path, file name or stem, without case", () => {
    expect(findImage("assets/fish.png", IMAGES)).toBe("assets/fish.png");
    expect(findImage("SALT.png", IMAGES)).toBe("assets/Salt.PNG");
    expect(findImage("fish", IMAGES)).toBe("assets/fish.png");
    expect(findImage("fish-1", IMAGES)).toBe("assets/cards/fish-1.png");
    expect(findImage("tea", IMAGES)).toBeNull();
    expect(findImage("  ", IMAGES)).toBeNull();
  });

  test("a row fills mapped fields and keeps defaults for the rest", () => {
    expect(rowValues(template, source, 0, IMAGES)).toEqual({
      values: { frame: "#2f6fb0", title: "Fish 1", art: "assets/fish.png" },
      warnings: [],
    });
  });

  test("unusable cells fall back and are reported with their row and column", () => {
    expect(rowValues(template, source, 1, ["assets/fish.png"])).toEqual({
      values: { frame: "#2f6fb0", title: "Salt 1", art: null },
      warnings: [
        'Row 2, color: "blue" is not a color like #2f6fb0',
        'Row 2, art: no imported image is named "salt.png"',
      ],
    });
  });

  test("empty cells use the defaults", () => {
    expect(rowValues(template, source, 2, IMAGES).values).toEqual(defaultValues(template));
  });

  test("mappings to columns the CSV lacks are listed once", () => {
    const narrow = { columns: ["id"], rows: [["a"]] };
    expect(missingColumns(template, narrow)).toEqual(["color", "name", "art", "copies"]);
  });
});

describe("planned cards", () => {
  test("ids come from the id column as slugs, else the template id and row number", () => {
    const plan = planCards(template, source, IMAGES);
    expect(plan.errors).toEqual([]);
    expect(plan.cards.map(({ row, id, name, count }) => ({ row, id, name, count }))).toEqual([
      { row: 0, id: "fish-1", name: "Fish 1", count: 4 },
      { row: 1, id: "salt-1", name: "Salt 1", count: 1 },
      { row: 2, id: "goods-3", name: "Goods 3", count: 2 },
    ]);
    expect(plan.warnings).toContain(
      'Row 2, copies: "x" is not a whole number from 1 to 100; 1 copy',
    );
  });

  test("two rows with one id stop generation", () => {
    const plan = planCards(
      template,
      { ...source, rows: [source.rows[0] ?? [], ["fish 1", "Again", "", "", "1"]] },
      IMAGES,
    );
    expect(plan.errors).toEqual(['Rows 1 and 2 would both make the card "fish-1"']);
  });

  test("a template without a source makes one card from its defaults", () => {
    expect(planCards(template, null, IMAGES)).toEqual({
      cards: [
        { row: null, id: "goods-1", name: "Goods", count: 1, values: defaultValues(template) },
      ],
      errors: [],
      warnings: [],
    });
  });

  test("slugs drop accents and punctuation", () => {
    expect(cardSlug("Épice  #3!")).toBe("epice-3");
    expect(cardSlug("---")).toBe("");
  });
});
