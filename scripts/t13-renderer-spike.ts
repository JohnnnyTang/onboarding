import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium, firefox, webkit } from "@playwright/test";

// Run `pnpm dev:table` first. These are desktop measurements, not a phone qualification.
const { values } = parseArgs({
  options: {
    browser: { type: "string", default: "all" },
    headed: { type: "boolean", default: false },
  },
});
const browsers = { chromium, firefox, webkit };
if (values.browser !== "all" && !Object.keys(browsers).includes(values.browser))
  throw new Error("--browser must be chromium, firefox, webkit or all");
const mode = values.headed ? "headed" : "headless";
const results: unknown[] = [];
const directory = new URL(`../.scratch/t13-spike/${mode}/`, import.meta.url);
await mkdir(directory, { recursive: true });
for (const [browserName, browserType] of Object.entries(browsers)) {
  if (values.browser !== "all" && values.browser !== browserName) continue;
  const browser = await browserType.launch({ headless: !values.headed });
  try {
    for (const width of [360, 1440]) {
      const page = await browser.newPage({
        viewport: { width, height: 800 },
        deviceScaleFactor: 2,
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      for (const engine of ["pixi", "three", "canvas"]) {
        await page.goto(`http://127.0.0.1:4313/dev/table/spike.html?engine=${engine}&measure=1`);
        await page.waitForFunction(() => Boolean(document.body.dataset.result), undefined, {
          timeout: 60000,
        });
        if (errors.length) throw new Error(errors.join("\n"));
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
        results.push({
          browser: browserName,
          browserVersion: browser.version(),
          mode,
          recordedAt: new Date().toISOString(),
          measurement: entry,
        });
        console.info(JSON.stringify(results.at(-1)));
        await page.screenshot({
          path: fileURLToPath(new URL(`${browserName}-${engine}-${width}.png`, directory)),
        });
        // Preserve completed measurements if a later browser or engine fails.
        await writeFile(
          new URL("results.json", directory),
          `${JSON.stringify(results, null, 2)}\n`,
        );
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
