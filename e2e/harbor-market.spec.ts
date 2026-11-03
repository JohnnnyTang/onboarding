import type { ComponentsFile, TableSnapshot } from "@bgp/schema";
import { expect, test } from "@playwright/test";
import declarations from "../games/harbor-market/components.json" with { type: "json" };
import game from "../games/harbor-market/src/index.js";
import { createMatch, viewFor } from "../packages/rules/src/index.js";
import { ComponentsFileSchema } from "../packages/schema/src/index.js";
import { fitViewport, layoutSnapshot, tableToScreen } from "../packages/table-2d/src/layout.js";

const components = ComponentsFileSchema.parse(declarations);

test("Harbor Market side-seat fan selects and swaps through the renderer", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 1000 });
  const state = createMatch(game, { seats: ["0", "1", "2", "3"], seed: 6, options: {} });
  state.ctx.currentSeat = "1";
  state.ctx.activeSeats = ["1"];
  const info = { seat: "1", components };
  const view = viewFor(game, state, "1");
  const snapshot = game.present(view, info);
  await page.goto("http://127.0.0.1:4313/dev/table/");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await page.evaluate(async (serialized) => {
    const { components, snapshot } = JSON.parse(serialized) as {
      components: ComponentsFile;
      snapshot: TableSnapshot;
    };
    const moduleUrl = "/packages/table-2d/dist/index.js";
    const { PixiTableRenderer } = (await import(moduleUrl)) as typeof import("@bgp/table-2d");
    const host = document.createElement("div");
    host.id = "harbor-test";
    host.style.cssText =
      "position:fixed;inset:0;width:1000px;height:1000px;z-index:100;background:#17392e";
    document.body.append(host);
    const renderer = new PixiTableRenderer();
    // Viewing from seat 0 keeps seat 1's fan vertical for this interaction test.
    await renderer.mount(host, {
      seat: "0",
      components,
      assetUrl: () => "data:image/png;base64,",
    });
    renderer.onSelectionChange((ids) => {
      host.dataset.selection = JSON.stringify(ids);
    });
    renderer.onGesture((gesture) => {
      host.dataset.gesture = JSON.stringify(gesture);
    });
    renderer.setSnapshot(snapshot);
  }, JSON.stringify({ components, snapshot }));
  const placements = layoutSnapshot(snapshot, components);
  const hand = placements.find((item) => item.item.zone === "hand:1" && item.item.index === 3);
  const market = placements.find((item) => item.item.zone === "market" && item.item.index === 1);
  if (!hand || !market) throw new Error("Game placements missing");
  const viewport = fitViewport(snapshot, 1000, 1000, "0");
  const from = tableToScreen(hand.x, hand.y, viewport);
  // The row drop index is an insertion position; just before the second card is index 1.
  const to = tableToScreen(market.x - 2, market.y, viewport);
  await page.mouse.click(...from);
  await expect(page.locator("#harbor-test")).toHaveAttribute(
    "data-selection",
    JSON.stringify([hand.item.id]),
  );
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(...to, { steps: 10 });
  await page.mouse.up();
  const gesture = JSON.parse(
    (await page.locator("#harbor-test").getAttribute("data-gesture")) ?? "null",
  );
  expect(gesture).toMatchObject({ kind: "drop", from: "hand:1", to: "market", index: 1 });
  expect(game.interpret?.(gesture, view, info)).toEqual({
    move: "swap",
    args: { hand: hand.item.id, market: market.item.id },
  });
});
