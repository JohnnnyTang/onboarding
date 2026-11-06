import type { CardTemplate, CardTextField } from "@bgp/schema";
import { describe, expect, test } from "vitest";
import {
  type CardContext,
  type CardImage,
  defaultValues,
  layoutText,
  paintCard,
  pixelSize,
  rowValues,
  wrapText,
} from "../src/index.js";
import { IMAGES, source, template } from "./fixtures.js";

/** Every character is half the font size wide. */
const sizeOf = (font: string) => Number(/([\d.]+)px/.exec(font)?.[1] ?? "10");
const measure = (font: string, text: string) => [...text].length * sizeOf(font) * 0.5;

type Call = [string, ...unknown[]];

/** A context that records what is drawn, with the state each call sees. */
function recorder(): { ctx: CardContext; calls: Call[] } {
  const calls: Call[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const ctx = {
    fillStyle: "#000000",
    font: "10px sans-serif",
    textAlign: "start",
    textBaseline: "alphabetic",
    save: record("save"),
    restore: record("restore"),
    beginPath: record("beginPath"),
    closePath: record("closePath"),
    moveTo: record("moveTo"),
    arcTo: record("arcTo"),
    rect: record("rect"),
    clip: record("clip"),
    fill() {
      calls.push(["fill", this.fillStyle]);
    },
    fillRect(...args: unknown[]) {
      calls.push(["fillRect", this.fillStyle, ...args]);
    },
    fillText(text: string, x: number, y: number) {
      calls.push(["fillText", text, Math.round(x), Math.round(y), this.font, this.textAlign]);
    },
    measureText(text: string) {
      return { width: measure(this.font, text) };
    },
    drawImage: record("drawImage"),
  };
  return { ctx: ctx as unknown as CardContext, calls };
}

const image = (width: number, height: number) => ({ width, height }) as unknown as CardImage;
const title = template.fields[1] as CardTextField;

describe("text layout", () => {
  const byChars = (text: string) => text.length;

  test("wraps at spaces and line breaks, and breaks words that cannot fit", () => {
    expect(wrapText("one two three", 7, byChars)).toEqual(["one two", "three"]);
    expect(wrapText("a\n\nb", 7, byChars)).toEqual(["a", "", "b"]);
    expect(wrapText("abcdefghij k", 4, byChars)).toEqual(["abcd", "efgh", "ij k"]);
    expect(wrapText("", 4, byChars)).toEqual([""]);
  });

  test("keeps the full size when the text fits", () => {
    expect(layoutText(title, "Fish", 10, measure)).toEqual({ sizePx: 60, lines: ["Fish"] });
  });

  test("shrinks long text in 5 % steps, never below half the size", () => {
    const shrunk = layoutText(title, "A long title that wraps", 10, measure);
    expect(shrunk.sizePx).toBeLessThan(60);
    expect(shrunk.sizePx).toBeGreaterThanOrEqual(30);
    expect(shrunk.lines.length * shrunk.sizePx * 1.2).toBeLessThanOrEqual(100);
    expect(layoutText(title, "word ".repeat(40), 10, measure).sizePx).toBeCloseTo(30);
  });
});

describe("painting", () => {
  test("300 dpi gives 744 × 1039 pixels for a 63 × 88 mm card", () => {
    expect(pixelSize([63, 88], 300)).toEqual([744, 1039]);
    expect(pixelSize([0.01, 0.01], 72)).toEqual([1, 1]);
  });

  test("draws the background, then each field clipped to its rectangle, in order", () => {
    const { ctx, calls } = recorder();
    const fish = image(100, 50);
    const values = rowValues(template, source, 0, IMAGES).values;
    // 254 dpi = 10 px per mm.
    paintCard(ctx, template, values, new Map([["assets/fish.png", fish]]), 254);
    const drawn = calls.filter(([name]) =>
      ["fillRect", "rect", "fill", "fillText", "drawImage"].includes(name),
    );
    expect(drawn).toEqual([
      ["fillRect", "#ffffff", 0, 0, 630, 880],
      ["rect", 0, 0, 630, 880],
      ["fill", "#2f6fb0"],
      ["rect", 40, 30, 550, 100],
      ["fillText", "Fish 1", 315, 80, 'bold 60.00px "BGP Source Serif 4", serif', "center"],
      ["rect", 40, 140, 550, 600],
      // contain: 100 × 50 scaled by 5.5 to 550 × 275, centered vertically in the field.
      ["drawImage", fish, 40, 302.5, 550, 275],
    ]);
    expect(calls.filter(([name]) => name === "save")).toHaveLength(
      calls.filter(([name]) => name === "restore").length,
    );
  });

  test("cover fills the field and crops the overflow", () => {
    const { ctx, calls } = recorder();
    const art = template.fields[2];
    if (art?.kind !== "image") throw new Error("fixture");
    const cover: CardTemplate = { ...template, fields: [{ ...art, fit: "cover" }] };
    const fish = image(100, 50);
    paintCard(ctx, cover, { art: "assets/fish.png" }, new Map([["assets/fish.png", fish]]), 254);
    expect(calls.find(([name]) => name === "drawImage")).toEqual([
      "drawImage",
      fish,
      -285,
      140,
      1200,
      600,
    ]);
  });

  test("missing images and empty text draw nothing", () => {
    const { ctx, calls } = recorder();
    const values = { ...defaultValues(template), title: "", art: "assets/none.png" };
    paintCard(ctx, template, values, new Map(), 300);
    expect(calls.some(([name]) => name === "fillText" || name === "drawImage")).toBe(false);
  });
});
