import type { CardTemplate, CardTextField } from "@bgp/schema";
import type { CardValues } from "./values.js";

// Draws a card template with Canvas 2D (contracts/card-generator.md#layout). The same code
// draws previews on a page canvas and 300 dpi faces on an OffscreenCanvas.

export const CARD_DPI = 300;
const MM_PER_INCH = 25.4;
const LINE_HEIGHT = 1.2;
const MIN_TEXT_SCALE = 0.5;
const TEXT_SCALE_STEP = 0.05;

/** The Canvas 2D calls the generator uses; page and offscreen contexts both have them. */
export type CardContext = Pick<
  CanvasRenderingContext2D,
  | "save"
  | "restore"
  | "beginPath"
  | "closePath"
  | "moveTo"
  | "arcTo"
  | "rect"
  | "clip"
  | "fill"
  | "fillRect"
  | "fillText"
  | "measureText"
  | "drawImage"
  | "fillStyle"
  | "font"
  | "textAlign"
  | "textBaseline"
>;

/** A decoded image with its size, such as an ImageBitmap. */
export type CardImage = CanvasImageSource & { readonly width: number; readonly height: number };

export function pixelsPerMm(dpi: number): number {
  return dpi / MM_PER_INCH;
}

/** Canvas size in whole pixels for a card of `size_mm` at `dpi`. */
export function pixelSize(size_mm: readonly [number, number], dpi: number): [number, number] {
  const scale = pixelsPerMm(dpi);
  return [Math.max(1, Math.round(size_mm[0] * scale)), Math.max(1, Math.round(size_mm[1] * scale))];
}

/** Splits a long word into pieces no wider than `width` (at least one character each). */
function breakWord(word: string, width: number, measure: (text: string) => number): string[] {
  const pieces: string[] = [];
  let piece = "";
  for (const char of word) {
    if (piece !== "" && measure(piece + char) > width) {
      pieces.push(piece);
      piece = char;
    } else {
      piece += char;
    }
  }
  if (piece !== "") pieces.push(piece);
  return pieces;
}

/**
 * Wraps text into lines no wider than `width`: at spaces, at "\n", and inside words that do
 * not fit on a line of their own.
 */
export function wrapText(text: string, width: number, measure: (text: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = "";
    for (const word of paragraph.split(/ +/).filter((part) => part !== "")) {
      const candidate = line === "" ? word : `${line} ${word}`;
      if (measure(candidate) <= width) {
        line = candidate;
        continue;
      }
      if (line !== "") lines.push(line);
      if (measure(word) <= width) {
        line = word;
      } else {
        const pieces = breakWord(word, width, measure);
        line = pieces.pop() ?? "";
        lines.push(...pieces);
      }
    }
    lines.push(line);
  }
  return lines;
}

export function fontFor(field: CardTextField, sizePx: number): string {
  return `${field.bold ? "bold " : ""}${sizePx.toFixed(2)}px ${field.font}`;
}

export interface TextLayout {
  sizePx: number;
  lines: string[];
}

/**
 * The largest size from `size_mm` down to half of it at which the wrapped text fits the
 * field's height, with its lines. Below half, lines that do not fit are cut off.
 */
export function layoutText(
  field: CardTextField,
  text: string,
  scale: number,
  measure: (font: string, text: string) => number,
): TextLayout {
  const width = field.rect_mm.w * scale;
  const height = field.rect_mm.h * scale;
  let layout: TextLayout = { sizePx: 0, lines: [] };
  for (let step = 0; ; step += 1) {
    const factor = Math.max(MIN_TEXT_SCALE, 1 - step * TEXT_SCALE_STEP);
    const sizePx = field.size_mm * scale * factor;
    const font = fontFor(field, sizePx);
    layout = { sizePx, lines: wrapText(text, width, (part) => measure(font, part)) };
    if (layout.lines.length * sizePx * LINE_HEIGHT <= height || factor === MIN_TEXT_SCALE) {
      return layout;
    }
  }
}

function roundedRect(
  ctx: CardContext,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawText(
  ctx: CardContext,
  field: CardTextField,
  text: string,
  scale: number,
  box: { x: number; y: number; w: number; h: number },
): void {
  const layout = layoutText(field, text, scale, (font, part) => {
    ctx.font = font;
    return ctx.measureText(part).width;
  });
  const lineHeight = layout.sizePx * LINE_HEIGHT;
  const total = layout.lines.length * lineHeight;
  const top =
    field.valign === "top"
      ? box.y
      : field.valign === "bottom"
        ? box.y + box.h - total
        : box.y + (box.h - total) / 2;
  const x =
    field.align === "left" ? box.x : field.align === "right" ? box.x + box.w : box.x + box.w / 2;
  ctx.font = fontFor(field, layout.sizePx);
  ctx.textAlign = field.align;
  ctx.textBaseline = "middle";
  ctx.fillStyle = field.color;
  for (const [index, line] of layout.lines.entries()) {
    ctx.fillText(line, x, top + lineHeight * (index + 0.5));
  }
}

function drawImage(
  ctx: CardContext,
  image: CardImage,
  fit: "contain" | "cover",
  box: { x: number; y: number; w: number; h: number },
): void {
  if (image.width <= 0 || image.height <= 0) return;
  const ratio =
    fit === "contain"
      ? Math.min(box.w / image.width, box.h / image.height)
      : Math.max(box.w / image.width, box.h / image.height);
  const w = image.width * ratio;
  const h = image.height * ratio;
  ctx.drawImage(image, box.x + (box.w - w) / 2, box.y + (box.h - h) / 2, w, h);
}

/**
 * Paints the card at `dpi` onto a context whose canvas is `pixelSize(template.size_mm, dpi)`.
 * `values` come from `rowValues` or `defaultValues`; `images` holds decoded project images
 * by path. A missing image draws nothing.
 */
export function paintCard(
  ctx: CardContext,
  template: CardTemplate,
  values: CardValues,
  images: ReadonlyMap<string, CardImage>,
  dpi: number,
): void {
  const scale = pixelsPerMm(dpi);
  const [width, height] = pixelSize(template.size_mm, dpi);
  ctx.save();
  ctx.fillStyle = template.background;
  ctx.fillRect(0, 0, width, height);
  for (const field of template.fields) {
    const value = values[field.id] ?? null;
    const box = {
      x: field.rect_mm.x * scale,
      y: field.rect_mm.y * scale,
      w: field.rect_mm.w * scale,
      h: field.rect_mm.h * scale,
    };
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip();
    if (field.kind === "box") {
      ctx.fillStyle = value ?? field.color;
      roundedRect(ctx, box.x, box.y, box.w, box.h, field.radius_mm * scale);
      ctx.fill();
    } else if (field.kind === "text") {
      if (value !== null && value !== "") drawText(ctx, field, value, scale, box);
    } else if (value !== null) {
      const image = images.get(value);
      if (image) drawImage(ctx, image, field.fit, box);
    }
    ctx.restore();
  }
  ctx.restore();
}
