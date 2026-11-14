import type { Gesture, ItemPlacement, TableSnapshot } from "@bgp/schema";
import { PixiTableRenderer } from "@bgp/table-2d";
import { components, fixture, fixtureAssets, stressFixture } from "./fixture.js";
import "./style.css";

const host = document.querySelector<HTMLElement>("#table");
if (!host) throw new Error("Table container missing");
const params = new URLSearchParams(location.search);
let current: TableSnapshot = structuredClone(params.has("stress") ? stressFixture : fixture);
let seat = params.get("seat") === "1" ? "1" : "0";
const meter = params.has("fps") ? frameMeter() : undefined;
let renderer = new PixiTableRenderer(meter?.frame);
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
  const canvas = host?.querySelector("canvas");
  if (canvas) meter?.attach(canvas);
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
    renderer = new PixiTableRenderer(meter?.frame);
    void mount();
  });
button("reset", () => renderer.resize());
button("clear", () => renderer.setSelection([]));
press(["fixture", "stress"], params.has("stress") ? "stress" : "fixture");
press(["seat-0", "seat-1"], `seat-${seat}`);
window.addEventListener("pagehide", () => renderer.destroy());
void mount();

/** `?fps=1`: intervals between frames submitted during the current or last continuous drag. */
function frameMeter() {
  const output = document.createElement("output");
  output.id = "frame-meter";
  output.className = "frame-meter";
  output.setAttribute("aria-live", "off");
  document.body.append(output);
  const intervals: number[] = [];
  let previous: number | undefined;
  let samples = 0;
  let backend = "";
  const details = () => `DPR ${devicePixelRatio} · ${backend}`;
  const instruction = () => `Drag a card for at least 30 frame intervals · ${details()}`;
  const reset = () => {
    intervals.length = 0;
    samples = 0;
    previous = undefined;
  };
  const show = () => {
    if (samples < 30) {
      output.textContent = instruction();
    } else {
      const sorted = [...intervals].sort((a, b) => a - b);
      const at = (p: number) => sorted[Math.floor((sorted.length - 1) * p)]?.toFixed(1);
      output.textContent = `p50 ${at(0.5)} ms · p95 ${at(0.95)} ms · ${intervals.length} intervals · ${details()}`;
    }
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && previous !== undefined) {
      show();
      reset();
    }
  });
  return {
    attach(canvas: HTMLCanvasElement) {
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      const info = gl?.getExtension("WEBGL_debug_renderer_info");
      const name = gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "hidden";
      backend = gl ? `${gl.getParameter(gl.VERSION)} · ${name}` : "WebGL unavailable";
      reset();
      show();
    },
    frame(time: number, dragging: boolean) {
      if (document.hidden) return;
      if (!dragging) {
        if (previous !== undefined) {
          show();
          reset();
        }
        return;
      }
      if (previous === undefined) {
        output.textContent = instruction();
      } else {
        intervals.push(time - previous);
        if (intervals.length > 180) intervals.shift();
        if (++samples % 30 === 0) show();
      }
      previous = time;
    },
  };
}
