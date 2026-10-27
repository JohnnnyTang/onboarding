import type { TableSnapshot } from "@bgp/schema";
import { Application, Sprite, Texture, VERSION } from "pixi.js";
import {
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
  REVISION,
  Scene,
  WebGLRenderer,
} from "three";
import {
  fitViewport,
  hitItem,
  layoutSnapshot,
  screenToTable,
  tableToScreen,
} from "../../packages/table-2d/src/layout.js";
import { components, fixture, fixtureAssets, stressFixture } from "./fixture.js";

interface Layer {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}
const params = new URLSearchParams(location.search);
const engine = params.get("engine") ?? "canvas";
const snapshot: TableSnapshot = params.get("fixture") === "all" ? fixture : stressFixture;
const width = innerWidth,
  height = innerHeight,
  ratio = devicePixelRatio;
const view = fitViewport(snapshot, width, height, "0");
const placements = layoutSnapshot(snapshot, components);
const assetUrl = fixtureAssets();
const layers: Layer[] = [];
const background = document.createElement("canvas");
background.width = width * ratio;
background.height = height * ratio;
const ctx = background.getContext("2d");
if (!ctx) throw new Error("Canvas unavailable");
ctx.scale(ratio, ratio);
ctx.fillStyle = "#15392f";
ctx.fillRect(0, 0, width, height);
for (const zone of snapshot.zones) {
  const [x, y] = tableToScreen(zone.rect_mm.x, zone.rect_mm.y, view);
  ctx.fillStyle = "#214c3d";
  ctx.strokeStyle = "#658470";
  ctx.fillRect(
    x - (zone.rect_mm.w * view.scale) / 2,
    y - (zone.rect_mm.h * view.scale) / 2,
    zone.rect_mm.w * view.scale,
    zone.rect_mm.h * view.scale,
  );
  ctx.strokeRect(
    x - (zone.rect_mm.w * view.scale) / 2,
    y - (zone.rect_mm.h * view.scale) / 2,
    zone.rect_mm.w * view.scale,
    zone.rect_mm.h * view.scale,
  );
  ctx.fillStyle = "#cbd8c5";
  ctx.font = "12px Arial";
  ctx.textAlign = "center";
  ctx.fillText(zone.label ?? zone.id, x, y - (zone.rect_mm.h * view.scale) / 2 + 14);
}
layers.push({ canvas: background, x: width / 2, y: height / 2, width, height, rotation: 0 });
for (const p of placements) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(p.width * 3);
  canvas.height = Math.ceil(p.height * 3);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  context.scale(3, 3);
  context.fillStyle = p.item.face === "down" ? "#35576b" : "#d49a64";
  context.fillRect(0, 0, p.width, p.height);
  context.strokeStyle = "#f4e9cf";
  context.strokeRect(1, 1, p.width - 2, p.height - 2);
  const def = components.defs.find((d) => d.id === p.item.def);
  const asset = def?.kind === "card" && p.item.face === "up" ? def.front : "assets/back.png";
  const image = new Image();
  image.src = assetUrl(asset);
  await image.decode().catch(() => {});
  if (image.naturalWidth) context.drawImage(image, 2, 2, p.width - 4, p.height - 4);
  context.fillStyle = "#f4e9cf";
  context.font = "7px Arial";
  context.textAlign = "center";
  context.fillText(p.item.id, p.width / 2, p.height - 5);
  const [x, y] = tableToScreen(p.x, p.y, view);
  layers.push({
    canvas,
    x,
    y,
    width: p.width * view.scale,
    height: p.height * view.scale,
    rotation: (p.rotation * Math.PI) / 180,
  });
}

let canvas: HTMLCanvasElement;
let render: () => void;
if (engine === "pixi") {
  const app = new Application();
  await app.init({
    width,
    height,
    resolution: ratio,
    autoDensity: true,
    antialias: true,
    preference: "webgl",
    autoStart: false,
  });
  canvas = app.canvas;
  const sprites = layers.map((layer) => {
    const sprite = new Sprite(Texture.from(layer.canvas));
    sprite.anchor.set(0.5);
    sprite.width = layer.width;
    sprite.height = layer.height;
    app.stage.addChild(sprite);
    return sprite;
  });
  render = () => {
    layers.forEach((layer, index) => {
      const sprite = sprites[index];
      if (sprite) {
        sprite.position.set(layer.x, layer.y);
        sprite.rotation = layer.rotation;
      }
    });
    app.render();
  };
} else if (engine === "three") {
  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(ratio);
  renderer.setSize(width, height);
  canvas = renderer.domElement;
  const scene = new Scene(),
    camera = new OrthographicCamera(0, width, height, 0, 0.1, 100);
  camera.position.z = 10;
  const geometry = new PlaneGeometry(1, 1);
  const meshes = layers.map((layer, index) => {
    const material = new MeshBasicMaterial({
      map: new CanvasTexture(layer.canvas),
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new Mesh(geometry, material);
    mesh.scale.set(layer.width, layer.height, 1);
    mesh.renderOrder = index;
    scene.add(mesh);
    return mesh;
  });
  render = () => {
    layers.forEach((layer, index) => {
      const mesh = meshes[index];
      if (mesh) {
        mesh.position.set(layer.x, height - layer.y, 0);
        mesh.rotation.z = -layer.rotation;
      }
    });
    renderer.render(scene, camera);
  };
} else {
  canvas = document.createElement("canvas");
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  render = () => {
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    for (const layer of layers) {
      context.save();
      context.translate(layer.x, layer.y);
      context.rotate(layer.rotation);
      context.drawImage(
        layer.canvas,
        -layer.width / 2,
        -layer.height / 2,
        layer.width,
        layer.height,
      );
      context.restore();
    }
  };
}
document.body.append(canvas);
let dragged: number | undefined;
canvas.addEventListener("pointerdown", (event) => {
  const p = hitItem(placements, ...screenToTable(event.clientX, event.clientY, view));
  if (p?.item.draggable) dragged = placements.indexOf(p) + 1;
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove", (event) => {
  const layer = dragged === undefined ? undefined : layers[dragged];
  if (layer) {
    layer.x = event.clientX;
    layer.y = event.clientY;
  }
});
canvas.addEventListener("pointerup", () => {
  dragged = undefined;
});
canvas.addEventListener("pointercancel", () => {
  dragged = undefined;
});
const intervals: number[] = [],
  submissions: number[] = [];
function graphicsBackend(): string {
  if (engine === "canvas") return "Canvas 2D";
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  const info = gl?.getExtension("WEBGL_debug_renderer_info");
  return info && gl ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "Unavailable";
}
const backend = graphicsBackend();
let previous = 0,
  frame = 0;
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)] ?? 0;
function tick(time: number): void {
  // Reproduce an active drag for a comparable workload in unattended measurements.
  const active = layers[150];
  if (params.has("measure") && active && dragged === undefined) {
    active.x = width / 2 + Math.sin(frame / 30) * 70;
    active.y = height / 2 + Math.cos(frame / 30) * 40;
  }
  const start = performance.now();
  render();
  const duration = performance.now() - start;
  if (frame > 60 && previous) {
    intervals.push(time - previous);
    submissions.push(duration);
  }
  previous = time;
  frame++;
  if (frame === 241) {
    const result = {
      engine,
      version: engine === "pixi" ? VERSION : engine === "three" ? REVISION : "platform",
      backend,
      items: placements.length,
      width,
      height,
      dpr: ratio,
      samples: intervals.length,
      frameP50: percentile(intervals, 0.5),
      frameP95: percentile(intervals, 0.95),
      submitP95: percentile(submissions, 0.95),
      userAgent: navigator.userAgent,
    };
    document.body.dataset.result = JSON.stringify(result);
    const output = document.getElementById("result");
    if (output) output.textContent = JSON.stringify(result);
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
