import type { CardTemplate } from "@bgp/schema";
import { CARD_DPI, type CardImage, paintCard, pixelSize } from "./paint.js";
import type { CardValues } from "./values.js";

// Card faces as PNG files, drawn on an OffscreenCanvas (tech-stack: Canvas 2D). Runs in a
// page or a worker; no network, so generation works offline.

export class CardRenderError extends Error {
  override readonly name = "CardRenderError";
}

/** Decodes project images for drawing; images that cannot be decoded are left out. */
export async function loadCardImages(
  blobs: Iterable<readonly [string, Blob]>,
): Promise<Map<string, ImageBitmap>> {
  const entries = await Promise.all(
    [...blobs].map(async ([path, blob]) => {
      try {
        return [path, await createImageBitmap(blob)] as const;
      } catch {
        return null;
      }
    }),
  );
  return new Map(entries.filter((entry) => entry !== null));
}

/** Renders one card face to a PNG at `dpi` (300 by default). */
export async function renderCardPng(
  template: CardTemplate,
  values: CardValues,
  images: ReadonlyMap<string, CardImage>,
  dpi: number = CARD_DPI,
): Promise<Blob> {
  const [width, height] = pixelSize(template.size_mm, dpi);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new CardRenderError("This browser cannot draw card faces.");
  paintCard(ctx, template, values, images, dpi);
  return canvas.convertToBlob({ type: "image/png" });
}

export interface RenderOptions {
  dpi?: number;
  /** PNG encodings in flight at once; browsers encode off the main thread. */
  concurrency?: number;
  /** Called after each face with the number done so far. */
  onProgress?(done: number, total: number): void;
  signal?: AbortSignal;
}

/** Renders many faces of one template, in order, a few PNG encodings at a time. */
export async function renderCardPngs(
  template: CardTemplate,
  rows: readonly CardValues[],
  images: ReadonlyMap<string, CardImage>,
  options: RenderOptions = {},
): Promise<Blob[]> {
  const { dpi = CARD_DPI, concurrency = 4, onProgress, signal } = options;
  const results: Blob[] = new Array<Blob>(rows.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < rows.length) {
      signal?.throwIfAborted();
      const index = next;
      next += 1;
      results[index] = await renderCardPng(template, rows[index] ?? {}, images, dpi);
      done += 1;
      onProgress?.(done, rows.length);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, rows.length)) }, worker),
  );
  return results;
}
