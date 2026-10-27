import type { ItemPlacement, TableSnapshot } from "@bgp/schema";
import { PixiTableRenderer } from "@bgp/table-2d";
import { components, fixture, fixtureAssets, stressFixture } from "./fixture.js";
import "./style.css";

const host = document.querySelector<HTMLElement>("#table");
if (!host) throw new Error("Table container missing");
const params = new URLSearchParams(location.search);
let current: TableSnapshot = structuredClone(params.has("stress") ? stressFixture : fixture);
let seat = params.get("seat") === "1" ? "1" : "0";
let renderer = new PixiTableRenderer();
const assetUrl = fixtureAssets();
async function mount(): Promise<void> {
  const instance = renderer;
  await instance.mount(host as HTMLElement, { components, assetUrl, seat });
  if (instance !== renderer) return;
  instance.onGesture((gesture) => {
    const output = document.querySelector("#gesture");
    if (output) output.textContent = JSON.stringify(gesture);
  });
  instance.onSelectionChange((ids) => {
    const output = document.querySelector("#selection");
    if (output)
      output.textContent = ids.length ? `Selected: ${ids.join(", ")}` : "No pieces selected";
  });
  instance.setSnapshot(current);
  document.body.dataset.ready = "true";
}
function button(id: string, callback: () => void): void {
  document.getElementById(id)?.addEventListener("click", callback);
}
button("fixture", () => {
  current = structuredClone(fixture);
  renderer.setSnapshot(current);
});
button("stress", () => {
  current = structuredClone(stressFixture);
  renderer.setSnapshot(current);
});
button("next", () => {
  current = {
    ...current,
    items: current.items.map((item): ItemPlacement => {
      if (item.id !== "market-0") return item;
      if (item.zone === "market") return { ...item, zone: "free", pos_mm: [200, -100] };
      const next = { ...item, zone: "market" };
      delete next.pos_mm;
      return next;
    }),
  };
  renderer.setSnapshot(current);
});
button("seat", () => {
  seat = seat === "0" ? "1" : "0";
  renderer.destroy();
  renderer = new PixiTableRenderer();
  void mount();
});
button("reset", () => renderer.resize());
window.addEventListener("pagehide", () => renderer.destroy());
void mount();
