import { GestureSchema } from "@bgp/schema";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { components, fixture } from "../dev/table/fixture.js";
import { fitViewport, layoutSnapshot, tableToScreen } from "../packages/table-2d/src/layout.js";

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

async function ready(page: Page): Promise<void> {
  await page.goto("http://127.0.0.1:4313/dev/table/");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  // All fixture images are local data URLs; wait for image decoding and the first rendered frame.
  await page.waitForTimeout(400);
}
async function position(page: Page, x: number, y: number, seat = "0"): Promise<[number, number]> {
  const box = await page.locator("#table").boundingBox();
  if (!box) throw new Error("Table not mounted");
  const [sx, sy] = tableToScreen(x, y, fitViewport(fixture, box.width, box.height, seat));
  return [box.x + sx, box.y + sy];
}

for (const width of [360, 1440]) {
  test(`all layouts at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await ready(page);
    await expect(page.locator("#table")).toHaveScreenshot(`table-${width}.png`, {
      maxDiffPixels: 100,
    });
    await page.getByRole("button", { name: "300 items" }).click();
    await page.waitForTimeout(400);
    await expect(page.locator("#table")).toHaveScreenshot(`stress-${width}.png`, {
      maxDiffPixels: 100,
    });
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test("selection, clickZone, and drops use contract shapes without predicting the move", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await ready(page);
  const card = layoutSnapshot(fixture, components).find((p) => p.item.id === "market-0");
  if (!card) throw new Error("Fixture card missing");
  const source = await position(page, card.x, card.y);
  await page.mouse.click(...source);
  await expect(page.locator("#selection")).toHaveText("Selected: market-0");
  expect(
    GestureSchema.parse(JSON.parse((await page.locator("#gesture").textContent()) ?? "")),
  ).toEqual({
    kind: "click",
    item: "market-0",
  });
  const target = await position(page, 200, -110);
  await page.mouse.move(...source);
  await page.mouse.down();
  await page.mouse.move(...target, { steps: 10 });
  await expect(page.locator("#table")).toHaveScreenshot("drop-feedback.png", {
    maxDiffPixels: 100,
  });
  await page.mouse.up();
  const gesture = GestureSchema.parse(
    JSON.parse((await page.locator("#gesture").textContent()) ?? ""),
  );
  expect(gesture).toMatchObject({
    kind: "drop",
    item: "market-0",
    from: "market",
    to: "free",
  });
  if (gesture.kind !== "drop" || !gesture.pos_mm) throw new Error("Free drop has no coordinates");
  expect(Math.abs(gesture.pos_mm[0] - 200)).toBeLessThanOrEqual(1);
  expect(Math.abs(gesture.pos_mm[1] + 110)).toBeLessThanOrEqual(1);
  await page.waitForTimeout(500);
  // A drop emits an intent; the original card remains until a new snapshot arrives.
  await page.mouse.click(...source);
  await expect(page.locator("#selection")).toHaveText("No pieces selected");
  await page.mouse.click(...(await position(page, 310, -130)));
  expect(
    GestureSchema.parse(JSON.parse((await page.locator("#gesture").textContent()) ?? "")),
  ).toEqual({
    kind: "clickZone",
    zone: "free",
  });
});

test("seat rotation and repeated authoritative snapshot animation", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await ready(page);
  await page.getByRole("button", { name: "View seat 1" }).click();
  await page.waitForTimeout(400);
  const card = layoutSnapshot(fixture, components).find((p) => p.item.id === "market-0");
  if (!card) throw new Error("Fixture missing");
  await page.mouse.click(...(await position(page, card.x, card.y, "1")));
  await expect(page.locator("#selection")).toHaveText("Selected: market-0");
  await expect(page.locator("#table")).toHaveScreenshot("seat-1.png", { maxDiffPixels: 100 });
  await page.getByRole("button", { name: "Next snapshot" }).click();
  await page.waitForTimeout(500);
  await page.mouse.click(...(await position(page, 200, -100, "1")));
  await expect(page.locator("#selection")).toHaveText("No pieces selected");
  await expect(page.locator("#table")).toHaveScreenshot("next-snapshot.png", {
    maxDiffPixels: 100,
  });
  await page.getByRole("button", { name: "Next snapshot" }).click();
  await page.waitForTimeout(500);
  await page.mouse.click(...(await position(page, card.x, card.y, "1")));
  await expect(page.locator("#selection")).toHaveText("Selected: market-0");
});

test("touch pinch and pan preserve integer table-coordinate drops", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 1000 });
  await ready(page);
  const canvas = page.locator("canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("No canvas");
  // Synthetic PointerEvents exercise the same multi-pointer path on all three engines.
  await canvas.evaluate((element, rect) => {
    const event = (type: string, id: number, x: number, y: number) =>
      element.dispatchEvent(
        new PointerEvent(type, {
          pointerId: id,
          pointerType: "touch",
          clientX: rect.x + x,
          clientY: rect.y + y,
          bubbles: true,
        }),
      );
    // Native capture requires a hardware-active pointer; stub capture only for this synthetic stream.
    element.setPointerCapture = () => {};
    event("pointerdown", 1, 100, 200);
    event("pointerdown", 2, 200, 200);
    event("pointermove", 2, 260, 230);
    event("pointerup", 2, 260, 230);
    event("pointerup", 1, 100, 200);
    event("pointerdown", 3, 15, 15);
    event("pointermove", 3, 30, 30);
    event("pointerup", 3, 30, 30);
  }, box);
  await expect(page.locator("#gesture")).toHaveText("Ready to play.");
  const card = layoutSnapshot(fixture, components).find((p) => p.item.id === "market-0");
  if (!card) throw new Error("No card");
  const view = fitViewport(fixture, box.width, box.height, "0");
  const factor = Math.hypot(160, 30) / 100;
  view.scale *= factor;
  view.panX = 180 - box.width / 2 - (150 - box.width / 2) * factor + 15;
  view.panY = 215 - box.height / 2 - (200 - box.height / 2) * factor + 15;
  const [sx, sy] = tableToScreen(card.x, card.y, view);
  const [tx, ty] = tableToScreen(150, -110, view);
  await page.mouse.click(box.x + sx, box.y + sy);
  await expect(page.locator("#selection")).toHaveText("Selected: market-0");
  await expect(page.locator("#table")).toHaveScreenshot("pinch-pan.png", {
    maxDiffPixels: 100,
  });
  await page.mouse.move(box.x + sx, box.y + sy);
  await page.mouse.down();
  await page.mouse.move(box.x + tx, box.y + ty, { steps: 8 });
  await page.mouse.up();
  const drop = GestureSchema.parse(
    JSON.parse((await page.locator("#gesture").textContent()) ?? ""),
  );
  expect(drop).toMatchObject({ kind: "drop", item: "market-0", to: "free" });
  if (drop.kind !== "drop" || !drop.pos_mm)
    throw new Error("Missing touch-transformed coordinates");
  expect(Math.abs(drop.pos_mm[0] - 150)).toBeLessThanOrEqual(2);
  expect(Math.abs(drop.pos_mm[1] + 110)).toBeLessThanOrEqual(2);
  await page.getByRole("button", { name: "Reset view" }).click();
  await page.waitForTimeout(500);
  await page.mouse.click(...(await position(page, card.x, card.y)));
  await expect(page.locator("#selection")).toHaveText("No pieces selected");
});

test("hidden backs, selection pruning, unsubscribing and teardown obey the renderer interface", async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const moduleUrl = "/packages/table-2d/dist/index.js";
    const fixtureUrl = "/dev/table/fixture.ts";
    const { PixiTableRenderer } = (await import(moduleUrl)) as typeof import("@bgp/table-2d");
    const { components, fixtureAssets } = (await import(
      fixtureUrl
    )) as typeof import("../dev/table/fixture.js");
    const host = document.createElement("div");
    host.style.cssText = "width:400px;height:400px";
    document.body.append(host);
    const table = new PixiTableRenderer();
    const refs: string[] = [],
      selections: string[][] = [];
    const asset = fixtureAssets();
    const off = table.onSelectionChange((ids) => selections.push(ids));
    await table.mount(host, {
      components,
      seat: "0",
      assetUrl: (ref) => {
        refs.push(ref);
        return asset(ref);
      },
    });
    table.setSnapshot({
      table: { size_mm: [400, 400] },
      zones: [{ id: "deck", layout: "stack", rect_mm: { x: 0, y: 0, w: 100, h: 100 } }],
      items: [{ id: "opaque", zone: "deck", face: "down", back: "back", selectable: true }],
    });
    table.setSelection(["opaque", "opaque", "unknown"]);
    table.setSnapshot({ table: { size_mm: [400, 400] }, zones: [], items: [] });
    off();
    table.setSelection([]);
    const canvasCount = host.querySelectorAll("canvas").length;
    table.destroy();
    table.destroy();
    const after = host.childElementCount;
    await table.mount(host, { components, seat: null, assetUrl: asset });
    const remounted = host.querySelectorAll("canvas").length;
    table.destroy();
    host.remove();
    return { refs, selections, canvasCount, after, remounted };
  });
  expect(result).toEqual({
    refs: ["assets/back.png"],
    selections: [["opaque"], []],
    canvasCount: 1,
    after: 0,
    remounted: 1,
  });
});
