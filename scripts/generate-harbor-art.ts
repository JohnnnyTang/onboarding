// Generates Harbor Market's card art with @bgp/card-generator (T16): the goods template and
// games/harbor-market/art/goods.csv give the 15 goods faces, the back template gives
// goods-back.png. The faces are drawn by the same Canvas 2D code the web app uses, in
// headless Chromium, and written to games/harbor-market/assets/. Run: pnpm art:harbor
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import { GAME, harborArt } from "./harbor-art.js";

/** The card generator as a classic script that sets globalThis.cardGenerator. */
async function generatorScript(): Promise<string> {
  const built = await build({
    stdin: {
      contents:
        'import { renderCardPng } from "./packages/card-generator/src/index.ts";\n' +
        "globalThis.cardGenerator = { renderCardPng };\n",
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
