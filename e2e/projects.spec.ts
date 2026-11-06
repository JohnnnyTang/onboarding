import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BrowserContext,
  type BrowserType,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { WEB_URL } from "./support/app.js";
import { solidPng } from "./support/png.js";

// E2E-01 (T15, T16): with the network disabled from the first edit on, a designer imports
// images, generates ten cards from a template and a CSV file, declares zones and setup, and
// plays hot-seat; the project survives a browser restart. The designer acts only through the
// page: forms, file inputs, a mouse drag on the zone editor, and the table's keyboard
// selection.

const IMAGES = [
  { name: "Fish.png", mimeType: "image/png", buffer: solidPng(63, 88, [40, 120, 200]) },
  { name: "Back.png", mimeType: "image/png", buffer: solidPng(63, 88, [150, 40, 40]) },
];

const GOODS = ["Fish", "Salt", "Silk", "Spice", "Tea"];
const COLORS = ["#2f6fb0", "#8a8f98", "#a2457a", "#c0612b", "#3a7d44"];

/** A goods CSV: id, name, color and art (an imported image named by its stem). */
function goodsCsv(rows: number): { name: string; mimeType: string; buffer: Buffer } {
  const lines = ["id,name,color,art"];
  for (let index = 0; index < rows; index += 1) {
    const good = GOODS[index % GOODS.length] ?? "Fish";
    const value = Math.floor(index / GOODS.length) + 1;
    lines.push(`${good.toLowerCase()}-${value},${good} ${value},${COLORS[index % 5]},fish`);
  }
  return { name: "goods.csv", mimeType: "text/csv", buffer: Buffer.from(lines.join("\r\n")) };
}

/**
 * Builds a "Goods" template on the Cards section: card ids and names from the CSV, a color
 * band filled from the color column over the title, and the art image from the art column.
 */
async function buildGoodsTemplate(page: Page, rows: number) {
  await section(page, "Cards").click();
  await page.getByLabel(/Import CSV/).setInputFiles(goodsCsv(rows));
  await expect(page.getByText(`${rows} rows`)).toBeVisible();
  await page.getByLabel("New template name").fill("Goods");
  await page.getByRole("button", { name: "Add template" }).click();
  const form = page.getByRole("form", { name: "Template Goods" });
  await form.getByLabel("CSV file").selectOption({ label: "goods.csv" });
  await form.getByLabel("Card ids from").selectOption("id");
  await form.getByLabel("Card names from").selectOption("name");

  await form.getByLabel("New field").selectOption("box");
  await form.getByRole("button", { name: "Add field" }).click();
  const band = form.getByRole("region", { name: "Field Box 1" });
  await band.getByLabel("Column (colors)").selectOption("color");
  for (const [label, value] of [
    ["Left", "0"],
    ["Top", "0"],
    ["Width", "63"],
    ["Height", "16"],
    ["Corner radius", "0"],
  ] as const) {
    await band.getByLabel(label).fill(value);
  }
  await band.getByRole("button", { name: "Draw earlier" }).click();
  await band.getByRole("button", { name: "Draw earlier" }).click();
  await band.getByRole("button", { name: "Draw earlier" }).click();
  await expect(band.getByRole("button", { name: "Draw earlier" })).toBeDisabled();

  await form.locator("summary", { hasText: "Title" }).click();
  await form
    .getByRole("region", { name: "Field Title" })
    .getByLabel("Column (its text)")
    .selectOption("name");
  await form.locator("summary", { hasText: "Art" }).click();
  await form
    .getByRole("region", { name: "Field Art" })
    .getByLabel("Column (image names)")
    .selectOption("art");
  return form;
}

/** The color of one pixel of the template preview, as #rrggbb. */
async function previewPixel(page: Page, x: number, y: number): Promise<string> {
  return page.getByTestId("card-preview").evaluate(
    (canvas: HTMLCanvasElement, { px, py }) => {
      const [r, g, b] = canvas.getContext("2d")?.getImageData(px, py, 1, 1).data ?? [];
      return `#${[r, g, b].map((part) => (part ?? 0).toString(16).padStart(2, "0")).join("")}`;
    },
    { px: x, py: y },
  );
}

/** Size and one pixel of a stored generated face, read back from IndexedDB. */
async function storedFace(page: Page, path: string) {
  return page.evaluate(async (wanted) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("bgp");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const records = await new Promise<{ path: string; blob: Blob }[]>((resolve, reject) => {
      const request = db.transaction("projectAssets").objectStore("projectAssets").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    const record = records.find((entry) => entry.path === wanted);
    if (!record) return null;
    const bitmap = await createImageBitmap(record.blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    ctx?.drawImage(bitmap, 0, 0);
    const [r, g, b] = ctx?.getImageData(20, 20, 1, 1).data ?? [];
    return {
      type: record.blob.type,
      size: [bitmap.width, bitmap.height],
      pixel: `#${[r, g, b].map((part) => (part ?? 0).toString(16).padStart(2, "0")).join("")}`,
    };
  }, path);
}

/** Starts a browser with a profile on disk, so closing it is a real browser restart. */
async function launch(
  type: BrowserType,
  profile: string,
): Promise<{ context: BrowserContext; page: Page; failed: string[] }> {
  const context = await type.launchPersistentContext(profile, {
    viewport: { width: 1280, height: 900 },
  });
  const failed: string[] = [];
  // Requests the page could not get. The service worker's own network-first attempt for a
  // navigation fails offline by design; it then answers with the cached app.
  context.on("requestfailed", (request) => {
    if (!request.serviceWorker()) failed.push(request.url());
  });
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page, failed };
}

const section = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name });
const table = (page: Page) => page.getByTestId("table").locator("canvas");

/** Screen position of a table point (mm) on the zone editor (800×600 table, 60 mm margin). */
async function zonePoint(canvas: Locator, x: number, y: number): Promise<[number, number]> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error("No zone canvas");
  return [box.x + ((x + 460) / 920) * box.width, box.y + ((360 - y) / 720) * box.height];
}

async function drag(page: Page, from: [number, number], to: [number, number]) {
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(...to, { steps: 8 });
  await page.mouse.up();
}

/** Every "caption, in zone" the table's keyboard focus visits, e.g. "Fish, in Hand". */
async function tableItems(page: Page, steps = 12): Promise<Set<string>> {
  await table(page).focus();
  const seen = new Set<string>();
  for (let step = 0; step < steps; step += 1) {
    await page.keyboard.press("ArrowRight");
    const label = (await table(page).getAttribute("aria-label")) ?? "";
    const match = /^Game table: (.+?, in [^,]+)/.exec(label);
    if (match?.[1]) seen.add(match[1]);
  }
  return seen;
}

/**
 * Moves the keyboard focus to the first item whose label starts with `prefix` and selects
 * it. Retried, because a table that was just switched to another seat may still be drawing.
 */
async function selectItem(page: Page, prefix: string) {
  await expect(async () => {
    await table(page).focus();
    const seen: string[] = [];
    for (let step = 0; step < 20; step += 1) {
      await page.keyboard.press("ArrowRight");
      const label = (await table(page).getAttribute("aria-label")) ?? "";
      seen.push(label);
      if (label.startsWith(`Game table: ${prefix}`)) {
        await page.keyboard.press("Space");
        await expect(table(page)).toHaveAttribute("aria-label", /, selected$/, { timeout: 2000 });
        return;
      }
    }
    throw new Error(`No table item ${prefix}; saw ${[...new Set(seen)].join(" | ")}`);
  }).toPass({ timeout: 20_000 });
}

/** Waits until the table, walked by keyboard, shows every one of `labels`. */
async function expectItems(page: Page, labels: string[]) {
  await expect
    .poll(
      async () => {
        const seen = await tableItems(page);
        return labels.filter((label) => !seen.has(label));
      },
      { timeout: 20_000 },
    )
    .toEqual([]);
}

const hud = (page: Page) => page.getByRole("list", { name: "Players" });

/** Generated goods cards a seat knows in a hand, e.g. "Spice 1, in Hand". */
const goodsInHand = (seen: Set<string>) =>
  [...seen].filter((label) => /^(Fish|Salt|Silk|Spice|Tea) \d, in Hand$/.test(label)).sort();

test("E2E-01: an offline project with generated cards, played hot-seat, survives a restart", async ({
  playwright,
  browserName,
}) => {
  test.setTimeout(240_000);
  // A short path: WebKit on Windows cannot keep its service worker storage under a deep
  // test-results folder (MAX_PATH), and the registration never completes there.
  const profile = mkdtempSync(join(tmpdir(), "bgp-e2e-"));
  test.info().attach("profile", { body: profile });
  let { context, page, failed } = await launch(playwright[browserName], profile);

  // The first visit installs the service worker; from then on the network is off.
  await page.goto(`${WEB_URL}/projects`);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();

  await page.getByLabel("New project").fill("Harbor Sketch");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: "Harbor Sketch", exact: true })).toBeVisible();

  // Images.
  await section(page, "Images").click();
  await page.getByLabel(/Import images/).setInputFiles(IMAGES);
  const images = page.getByRole("list", { name: "Project images" });
  await expect(images.getByText("fish.png")).toBeVisible();
  await expect(images.getByText("back.png")).toBeVisible();

  // Components: a card (which brings a card back with it) and a die.
  await section(page, "Components").click();
  await page.getByRole("button", { name: "Add component" }).click();
  const card = page.getByRole("form", { name: "Edit Card 1" });
  await card.getByLabel("Name").fill("Fish");
  await card.getByLabel("Front image").selectOption("assets/fish.png");
  await card.getByRole("button", { name: "Save component" }).click();
  // Saved: the form is now named after the card.
  await expect(page.getByRole("form", { name: "Edit Fish" }).getByRole("status")).toHaveText(
    "Saved",
  );
  await page.locator("summary", { hasText: "Card back" }).click();
  const back = page.getByRole("form", { name: "Edit Card back" });
  await back.getByLabel("Image").selectOption("assets/back.png");
  await back.getByRole("button", { name: "Save component" }).click();
  await expect(back.getByRole("status")).toHaveText("Saved");
  await page.getByLabel("Kind").selectOption("die");
  await page.getByRole("button", { name: "Add component" }).click();
  await expect(page.getByRole("form", { name: "Edit Die 1" })).toBeVisible();

  // Cards: ten goods from a template and a CSV file, drawn at 300 dpi.
  const template = await buildGoodsTemplate(page, 10);
  await page.getByLabel("Preview row (of 10)").fill("4");
  await expect(page.getByRole("img", { name: "Preview of Goods, row 4" })).toBeVisible();
  // Row 4 is spice: its color band is drawn from the CSV.
  await expect.poll(() => previewPixel(page, 10, 10)).toBe("#c0612b");
  await template.getByRole("button", { name: "Generate 10 cards" }).click();
  await expect(template.getByText(/^Generated 10 cards in [\d.]+ s at 300 dpi/)).toBeVisible();
  // All 24 bundled font faces loaded, offline, from the service worker's cache.
  expect(
    await page.evaluate(
      () =>
        [...document.fonts].filter(
          (face) => face.family.includes("BGP ") && face.status === "loaded",
        ).length,
    ),
  ).toBe(24);
  expect(await storedFace(page, "assets/cards/spice-1.png")).toEqual({
    type: "image/png",
    size: [744, 1039],
    pixel: "#c0612b",
  });
  await section(page, "Components").click();
  for (const name of ["Fish 1", "Tea 2"]) {
    await expect(
      page.getByRole("list", { name: "Component list" }).getByText(name, { exact: true }),
    ).toBeVisible();
  }

  // Zones on the table: draw the deck, resize it by a corner, then add a market and hands.
  await section(page, "Table").click();
  const canvas = page.getByTestId("zone-canvas");
  await drag(page, await zonePoint(canvas, -300, 150), await zonePoint(canvas, -200, 30));
  let zone = page.getByRole("form", { name: "Zone zone-1" });
  await expect(zone.getByLabel("Width (mm)")).toHaveValue("100");
  const handle = canvas.locator('[data-zone="zone-1"] [data-handle="se"]');
  const handleBox = await handle.boundingBox();
  if (!handleBox) throw new Error("No resize handle");
  const corner: [number, number] = [
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2,
  ];
  await drag(page, corner, await zonePoint(canvas, -180, 30));
  await expect(zone.getByLabel("Width (mm)")).toHaveValue("120");
  await zone.getByLabel("Label").fill("Deck");
  await zone.getByRole("button", { name: "Save zone" }).click();

  await page.getByRole("button", { name: "Add zone in the middle" }).click();
  zone = page.getByRole("form", { name: "Zone zone-2" });
  await zone.getByLabel("Label").fill("Market");
  await zone.getByLabel("Layout").selectOption("row");
  await zone.getByLabel("Width (mm)").fill("260");
  await zone.getByRole("button", { name: "Save zone" }).click();
  await expect(page.getByRole("form", { name: "Zone Market" })).toBeVisible();

  await page.getByRole("button", { name: "Add zone in the middle" }).click();
  zone = page.getByRole("form", { name: "Zone zone-3" });
  await zone.getByLabel("Label").fill("Hand");
  await zone.getByLabel("Layout").selectOption("fan");
  await zone.getByLabel("Owner").selectOption("each");
  await zone.getByLabel("Who sees the items").selectOption("owner");
  await zone.getByLabel("Center y (mm)").fill("-200");
  await zone.getByLabel("Width (mm)").fill("400");
  await zone.getByRole("button", { name: "Save zone" }).click();
  await expect(page.getByRole("form", { name: "Zone Hand" })).toBeVisible();

  // Setup: the ten generated cards face down and shuffled in the deck, the die in the market.
  await section(page, "Cards").click();
  const placement = page.getByRole("group", { name: "Starting setup" });
  await expect(placement.getByLabel("Put the generated cards in")).toHaveValue("zone-1");
  await expect(placement.getByLabel("Shuffle")).toBeChecked();
  await placement.getByRole("button", { name: "Add 10 cards to setup" }).click();
  await expect(placement.getByRole("status")).toHaveText("Setup places 10 cards in Deck.");
  await section(page, "Setup").click();
  const deckLine = page.getByRole("listitem", { name: "Setup line 1", exact: true });
  await expect(deckLine.getByLabel("Component")).toHaveValue("fish-1");
  await expect(deckLine.getByLabel("Face")).toHaveValue("down");
  await page.getByRole("button", { name: "Add setup line" }).click();
  const dieLine = page.getByRole("listitem", { name: "Setup line 11" });
  await dieLine.getByLabel("Component").selectOption("die-1");
  await dieLine.getByLabel("Zone", { exact: true }).selectOption("zone-2");
  await expect(deckLine.getByLabel("Shuffle the zone")).toBeChecked();
  await expect(dieLine.getByLabel("Zone", { exact: true })).toHaveValue("zone-2");

  // Hot-seat: deal from the deck as seat 1, then look at the table from each seat.
  await page.getByRole("link", { name: "Play hot-seat" }).click();
  await expect(page.getByRole("button", { name: "Seat 1", pressed: true })).toBeVisible();
  await expect(hud(page).getByRole("listitem")).toHaveCount(2);
  await selectItem(page, "Card back, in Deck");
  await page.getByRole("button", { name: "Deal 1 to each Hand" }).click();
  await expect(page.getByText("1 move so far")).toBeVisible();
  await expect(hud(page).getByText("Hand 1")).toHaveCount(2);

  // Seat 1 knows its own generated card only; the other hand and the deck show backs.
  await expectItems(page, ["Card back, in Hand", "Card back, in Deck"]);
  await expect
    .poll(async () => goodsInHand(await tableItems(page)), { timeout: 20_000 })
    .toHaveLength(1);
  const seatOneCards = goodsInHand(await tableItems(page));

  await page.getByRole("button", { name: "Seat 2" }).click();
  await expect(page.getByRole("button", { name: "Seat 2", pressed: true })).toBeVisible();
  await selectItem(page, "Die 1, in Market");
  await page.getByRole("button", { name: "Roll" }).click();
  await expect(page.getByText("2 moves so far")).toBeVisible();
  await expectItems(page, ["Card back, in Hand"]);
  const seatTwoCards = goodsInHand(await tableItems(page));
  expect(seatTwoCards).toHaveLength(1);
  expect(seatTwoCards).not.toEqual(seatOneCards);

  // All seats: both hands are known; the deck is still hidden from everyone.
  await page.getByRole("button", { name: "All seats" }).click();
  await expect(page.getByText(/^All seats: everything any seat may see/)).toBeVisible();
  await expect
    .poll(async () => [...(await tableItems(page))].sort(), { timeout: 20_000 })
    .toEqual(["Card back, in Deck", "Die 1, in Market", ...seatOneCards, ...seatTwoCards].sort());

  expect(failed.filter((url) => url.startsWith(WEB_URL))).toEqual([]);

  // Restart the browser, still offline: the project, its cards and its game are still there.
  await context.close();
  ({ context, page, failed } = await launch(playwright[browserName], profile));
  await context.setOffline(true);
  await page.goto(`${WEB_URL}/projects`);
  await expect(page.getByRole("link", { name: "Harbor Sketch" })).toBeVisible();
  await page
    .getByRole("listitem")
    .filter({ hasText: "Harbor Sketch" })
    .getByRole("link", { name: "Play" })
    .click();
  await expect(page.getByText("2 moves so far")).toBeVisible();
  await expect(hud(page).getByText("Hand 1")).toHaveCount(2);
  await expectItems(page, ["Card back, in Hand", ...seatOneCards]);
  expect(await storedFace(page, "assets/cards/tea-2.png")).toMatchObject({ size: [744, 1039] });
  expect(failed.filter((url) => url.startsWith(WEB_URL))).toEqual([]);
  await context.close();
  // Windows can hold the closed browser's files for a moment (EPERM); rmSync retries.
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("T16: 100 cards are generated at 300 dpi in under 10 seconds", async ({
  playwright,
  browserName,
}) => {
  test.setTimeout(120_000);
  // A profile on disk: WebKit cannot keep Blobs in IndexedDB in an ephemeral context.
  const profile = mkdtempSync(join(tmpdir(), "bgp-e2e-"));
  const { context, page } = await launch(playwright[browserName], profile);
  await page.goto(`${WEB_URL}/projects`);
  await page.getByLabel("New project").fill("Hundred Cards");
  await page.getByRole("button", { name: "Create project" }).click();
  await section(page, "Images").click();
  await page.getByLabel(/Import images/).setInputFiles(IMAGES.slice(0, 1));
  await expect(
    page.getByRole("list", { name: "Project images" }).getByText("fish.png"),
  ).toBeVisible();
  const template = await buildGoodsTemplate(page, 100);
  const generate = template.getByRole("button", { name: "Generate 100 cards" });
  const started = Date.now();
  await generate.click();
  await expect(template.getByText(/^Generated 100 cards in [\d.]+ s/)).toBeVisible({
    timeout: 30_000,
  });
  const elapsed = Date.now() - started;
  const reported = await template.getByText(/^Generated 100 cards/).textContent();
  test.info().annotations.push({ type: "generation", description: `${elapsed} ms; ${reported}` });
  expect(elapsed).toBeLessThan(10_000);
  expect(await storedFace(page, "assets/cards/tea-20.png")).toEqual({
    type: "image/png",
    size: [744, 1039],
    pixel: "#3a7d44",
  });
  await context.close();
  // Windows can hold the closed browser's files for a moment (EPERM); rmSync retries.
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
