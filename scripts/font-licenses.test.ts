import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { CARD_FONTS } from "../packages/card-generator/src/index.js";

// The web app redistributes the card fonts, so it ships each one's SIL OFL text (Q-023).
const fromWeb = createRequire(new URL("../apps/web/package.json", import.meta.url));

test.each(CARD_FONTS.map((font) => font.id))("the app ships the OFL license of %s", async (id) => {
  const packaged = await readFile(fromWeb.resolve(`@fontsource/${id}/LICENSE`), "utf8");
  const shipped = await readFile(
    new URL(`../apps/web/public/licenses/fonts/${id}-OFL.txt`, import.meta.url),
    "utf8",
  );
  expect(shipped).toBe(packaged);
  expect(shipped).toContain("SIL Open Font License");
});
