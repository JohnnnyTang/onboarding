import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";
import { build } from "esbuild";
import { record } from "../games/harbor-market/test/browser-replay.js";
import { harborInit, sampleHarborCases } from "../games/harbor-market/test/property-cases.js";

declare const harborReplay: typeof import("../games/harbor-market/test/browser-replay.js");

test("AC-08: Chromium replays every Node state hash in random Harbor Market games", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "E2E-06 separately covers the browser matrix");
  test.setTimeout(30 * 60 * 1000);
  const numRuns = Number(process.env.BGP_PROPERTY_RUNS ?? 20);
  if (!Number.isSafeInteger(numRuns) || numRuns < 1) {
    throw new Error("BGP_PROPERTY_RUNS must be a positive integer");
  }
  const cases = sampleHarborCases(numRuns);
  const entry = new URL("../games/harbor-market/test/browser-replay.ts", import.meta.url);
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(entry)],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "harborReplay",
    write: false,
  });
  const [bundle] = outputFiles;
  if (!bundle) throw new Error("Missing browser replay bundle");

  // Isolated test page with Web Crypto. Only synthetic event traces reach this page.
  const url = "https://harbor-replay.test/";
  await page.route(url, (route) =>
    route.fulfill({ contentType: "text/html", body: "<html></html>" }),
  );
  await page.goto(url);
  await page.addScriptTag({ content: bundle.text });

  let hashes = 0;
  for (const [index, [seed, botSeed, count, shortGame]] of cases.entries()) {
    const label = `Game ${index + 1}: seed ${seed}, bot seed ${botSeed}, ${count} seats, short=${shortGame}`;
    await test.step(label, async () => {
      const trace = await record(harborInit(seed, count, shortGame), botSeed);
      await page.evaluate<void, unknown>(
        (input) => harborReplay.verify(input as typeof trace),
        trace,
      );
      hashes += trace.hashes.length;
    });
    if ((index + 1) % 100 === 0) console.log(`Verified ${index + 1} browser replays`);
  }
  console.log(`Verified ${hashes} Node state hashes across ${cases.length} Chromium replays`);
});
