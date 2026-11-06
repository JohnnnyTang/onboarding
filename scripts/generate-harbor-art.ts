// Generates Harbor Market's card art with @bgp/card-generator (T16): the goods template and
// games/harbor-market/art/goods.csv give the 15 goods faces, the back template gives
// goods-back.png. The faces are drawn by the same Canvas 2D code the web app uses, in
// headless Chromium with the app's bundled fonts, and written to games/harbor-market/assets/.
// Run: pnpm art:harbor
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import {
  CARD_FONT_SUBSETS,
  CARD_FONT_WEIGHTS,
  CARD_FONTS,
  type CardFontId,
  type CardFontWeight,
  cardFontFileName,
} from "../packages/card-generator/src/index.js";
import { GAME, harborArt } from "./harbor-art.js";

// The fonts come from the web app's pinned Fontsource packages, the files it ships.
const fromWeb = createRequire(new URL("../apps/web/package.json", import.meta.url));

interface FontFile {
  font: CardFontId;
  weight: CardFontWeight;
  unicodeRange: string;
  base64: string;
}

async function fontFiles(): Promise<FontFile[]> {
  const files: FontFile[] = [];
  for (const { id } of CARD_FONTS) {
    const ranges: Record<string, string> = JSON.parse(
      await readFile(fromWeb.resolve(`@fontsource/${id}/unicode.json`), "utf8"),
    );
    for (const subset of CARD_FONT_SUBSETS) {
      const unicodeRange = ranges[subset];
      if (!unicodeRange) throw new Error(`No ${subset} range for ${id}`);
      for (const weight of CARD_FONT_WEIGHTS) {
        const file = fromWeb.resolve(
          `@fontsource/${id}/files/${cardFontFileName(id, subset, weight)}`,
        );
        files.push({
          font: id,
          weight,
          unicodeRange,
          base64: (await readFile(file)).toString("base64"),
        });
      }
    }
  }
  return files;
}

/** The card generator as a classic script that sets globalThis.cardGenerator. */
async function generatorScript(): Promise<string> {
  const built = await build({
    stdin: {
      contents:
        'import { loadCardFonts, renderCardPng } from "./packages/card-generator/src/index.ts";\n' +
        "globalThis.cardGenerator = { loadCardFonts, renderCardPng };\n",
      resolveDir: fileURLToPath(new URL("../", import.meta.url)),
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  const output = built.outputFiles[0];
  if (!output) throw new Error("Card generator bundle missing");
  return output.text;
}

async function main() {
  const art = await harborArt();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><title>Harbor Market art</title>");
    await page.addScriptTag({ content: await generatorScript() });
    await page.evaluate(
      async (files) => {
        const generator = (
          globalThis as unknown as {
            cardGenerator: { loadCardFonts(faces: unknown[], fonts: FontFaceSet): Promise<void> };
          }
        ).cardGenerator;
        const faces = files.map(({ base64, ...face }) => {
          const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
          return { ...face, source: bytes.buffer };
        });
        await generator.loadCardFonts(faces, document.fonts);
      },
      await fontFiles(),
    );
    await mkdir(new URL("assets/", GAME), { recursive: true });
    for (const [path, { template, values }] of art.faces) {
      const base64 = await page.evaluate(
        async ({ template, values }) => {
          const generator = (
            globalThis as unknown as {
              cardGenerator: {
                renderCardPng(t: unknown, v: unknown, i: Map<string, unknown>): Promise<Blob>;
              };
            }
          ).cardGenerator;
          const blob = await generator.renderCardPng(template, values, new Map());
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let text = "";
          for (const byte of bytes) text += String.fromCharCode(byte);
          return btoa(text);
        },
        { template, values },
      );
      const bytes = Buffer.from(base64, "base64");
      await writeFile(new URL(path, GAME), bytes);
      console.log(`${path} ${Math.round(bytes.length / 1024)} KB`);
    }
  } finally {
    await browser.close();
  }
}

await main();
