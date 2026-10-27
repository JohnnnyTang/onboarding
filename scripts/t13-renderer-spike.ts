import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "@playwright/test";

// Run `pnpm dev:table` first. These are desktop/proxy measurements, not a phone qualification.
const results: unknown[] = [];
const directory = new URL("../.scratch/t13-spike/", import.meta.url);
await mkdir(directory, { recursive: true });
for (const [browserName, browserType] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await browserType.launch();
  try {
    for (const width of [360, 1440]) {
      const page = await browser.newPage({
        viewport: { width, height: 800 },
        deviceScaleFactor: 2,
      });
      for (const engine of ["pixi", "three", "canvas"]) {
        await page.goto(`http://127.0.0.1:4313/dev/table/spike.html?engine=${engine}&measure=1`);
        await page.waitForFunction(() => Boolean(document.body.dataset.result), undefined, {
          timeout: 60000,
        });
        const result = await page.locator("body").getAttribute("data-result");
        if (!result) throw new Error("Spike result missing");
        const entry: unknown = JSON.parse(result);
        if (
          engine === "pixi" &&
          (!entry ||
            typeof entry !== "object" ||
            !("version" in entry) ||
            entry.version !== "8.6.6")
        )
          throw new Error("Restart Vite with --force: the Pixi dependency is stale");
        results.push({ browser: browserName, measurement: entry });
        console.info(JSON.stringify(results.at(-1)));
        await page.screenshot({
          path: fileURLToPath(new URL(`${browserName}-${engine}-${width}.png`, directory)),
        });
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
await writeFile(new URL("results.json", directory), `${JSON.stringify(results, null, 2)}\n`);
