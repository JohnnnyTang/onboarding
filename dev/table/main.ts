import type { Gesture, ItemPlacement, TableSnapshot } from "@bgp/schema";
import { PixiTableRenderer } from "@bgp/table-2d";
import { components, fixture, fixtureAssets, stressFixture } from "./fixture.js";
import "./style.css";

const host = document.querySelector<HTMLElement>("#table");
if (!host) throw new Error("Table container missing");
const params = new URLSearchParams(location.search);
let current: TableSnapshot = structuredClone(params.has("stress") ? stressFixture : fixture);
let seat = params.get("seat") === "1" ? "1" : "0";
let renderer = new PixiTableRenderer();
let gestureCount = 0;
const MAX_LOG = 8;
const assetUrl = fixtureAssets();

function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Workshop element ${selector} missing`);
  return found;
}

/** Plain-language line for a gesture, using the ids that appear in its payload. */
function gestureLine(gesture: Gesture): [kind: string, text: string] {
  if (gesture.kind === "click") return ["Click", gesture.item];
  if (gesture.kind === "clickZone") return ["Zone", `empty space in ${gesture.zone}`];
  const where = gesture.pos_mm
    ? `at ${gesture.pos_mm[0]}, ${gesture.pos_mm[1]} mm`
    : `at index ${gesture.index ?? 0}`;
  return ["Drop", `${gesture.item} from ${gesture.from} to ${gesture.to}, ${where}`];
}

function logGesture(gesture: Gesture): void {
  gestureCount += 1;
  const [kind, text] = gestureLine(gesture);
  const entry = document.createElement("li");
  const n = document.createElement("span");
  n.className = "n";
  n.textContent = String(gestureCount);
  const label = document.createElement("span");
  label.className = `kind ${gesture.kind === "drop" ? "drop" : ""}`;
  label.textContent = kind;
  const body = document.createElement("span");
  body.textContent = text;
  entry.append(n, label, body);
  const log = element<HTMLOListElement>("#log");
  log.prepend(entry);
  while (log.children.length > MAX_LOG) log.lastElementChild?.remove();
  element("#gesture").textContent = JSON.stringify(gesture);
}

function showTurn(snapshot: TableSnapshot): void {
  element("#prompt").textContent = snapshot.prompt ?? "";
  const rows = element<HTMLTableSectionElement>("#players tbody");
  rows.replaceChildren();
  const hud = snapshot.hud ?? [];
  if (hud.length === 0) {
    const row = rows.insertRow();
    row.className = "empty";
    const cell = row.insertCell();
    cell.colSpan = 3;
    cell.textContent = "This snapshot has no player readout.";
    return;
  }
  for (const entry of hud) {
    const row = rows.insertRow();
    if (entry.active) row.className = "active";
    const name = row.insertCell();
    name.textContent = entry.name ?? `Seat ${entry.seat}`;
    const seatLabel = document.createElement("span");
    seatLabel.className = "seat";
    seatLabel.textContent = entry.active ? `seat ${entry.seat}, playing` : `seat ${entry.seat}`;
    name.append(seatLabel);
    row.insertCell().textContent = entry.score === undefined ? "–" : String(entry.score);
    row.insertCell().textContent = entry.handCount === undefined ? "–" : String(entry.handCount);
  }
}

function showSelection(ids: string[]): void {
  element("#selection").textContent = ids.length
    ? `Selected: ${ids.join(", ")}`
    : "No pieces selected";
  element<HTMLButtonElement>("#clear").disabled = ids.length === 0;
}

function setSnapshot(snapshot: TableSnapshot): void {
  current = snapshot;
  renderer.setSnapshot(current);
  showTurn(current);
}

function press(group: string[], active: string): void {
  for (const id of group)
    element<HTMLButtonElement>(`#${id}`).setAttribute("aria-pressed", String(id === active));
}

async function mount(): Promise<void> {
  const instance = renderer;
  await instance.mount(host as HTMLElement, { components, assetUrl, seat });
  if (instance !== renderer) return;
  instance.onGesture(logGesture);
  instance.onSelectionChange(showSelection);
  setSnapshot(current);
  document.body.dataset.ready = "true";
}

function button(id: string, callback: () => void): void {
  element(`#${id}`).addEventListener("click", callback);
}
button("fixture", () => {
  press(["fixture", "stress"], "fixture");
  setSnapshot(structuredClone(fixture));
});
button("stress", () => {
  press(["fixture", "stress"], "stress");
  setSnapshot(structuredClone(stressFixture));
});
button("next", () => {
  setSnapshot({
    ...current,
    items: current.items.map((item): ItemPlacement => {
      if (item.id !== "market-0") return item;
      if (item.zone === "market") return { ...item, zone: "free", pos_mm: [200, -100] };
      const next = { ...item, zone: "market" };
      delete next.pos_mm;
      return next;
    }),
  });
});
for (const id of ["0", "1"])
  button(`seat-${id}`, () => {
    if (seat === id) return;
    seat = id;
    press(["seat-0", "seat-1"], `seat-${id}`);
    showSelection([]);
    renderer.destroy();
    renderer = new PixiTableRenderer();
    void mount();
  });
button("reset", () => renderer.resize());
button("clear", () => renderer.setSelection([]));
press(["fixture", "stress"], params.has("stress") ? "stress" : "fixture");
press(["seat-0", "seat-1"], `seat-${seat}`);
window.addEventListener("pagehide", () => renderer.destroy());
void mount();

/**
 * `?fps=1`: frame intervals on screen, for phones without developer tools (T20 device
 * qualification). Every animation frame is timed; the overlay shows p50 and p95 of the last
 * 180 intervals, the device pixel ratio and the WebGL renderer string where exposed. Drag a
 * card while reading it: an idle table stops drawing, so idle intervals mean little.
 */
function frameMeter(): void {
  const output = document.createElement("output");
  output.className = "frame-meter";
  output.setAttribute("aria-live", "off");
  document.body.append(output);
  const probe = document.createElement("canvas").getContext("webgl");
  const debug = probe?.getExtension("WEBGL_debug_renderer_info");
  const backend = debug ? String(probe?.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : "hidden";
  const intervals: number[] = [];
  let previous: number | undefined;
  let frame = 0;
  const tick = (time: number) => {
    if (previous !== undefined) intervals.push(time - previous);
    if (intervals.length > 180) intervals.shift();
    previous = time;
    frame += 1;
    if (frame % 30 === 0 && intervals.length > 0) {
      const sorted = [...intervals].sort((a, b) => a - b);
      const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
      output.textContent = `p50 ${at(0.5)?.toFixed(1)} ms · p95 ${at(0.95)?.toFixed(1)} ms · DPR ${devicePixelRatio} · ${backend}`;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
if (params.has("fps")) frameMeter();
