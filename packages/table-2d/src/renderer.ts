import type {
  AssetRef,
  ComponentsFile,
  Gesture,
  SeatId,
  TableRenderer,
  TableSnapshot,
} from "@bgp/schema";
import { ComponentsFileSchema, TableSnapshotSchema } from "@bgp/schema";
import { Application, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import type { PlacedItem, Viewport } from "./layout.js";
import {
  dropGesture,
  fitViewport,
  hitItem,
  hitZone,
  layoutSnapshot,
  screenToTable,
} from "./layout.js";

type Init = { components: ComponentsFile; assetUrl(ref: AssetRef): string; seat: SeatId | null };
interface Visual {
  node: Container;
  signature: string;
  revision: number;
  target: PlacedItem;
}
interface Pointer {
  x: number;
  y: number;
}
interface Press {
  x: number;
  y: number;
  item?: PlacedItem;
  moved: boolean;
}
const EMPTY: TableSnapshot = { table: { size_mm: [800, 600] }, zones: [], items: [] };
const COLORS = {
  ink: 0xe9e1ce,
  muted: 0x96b6aa,
  line: 0x416256,
  legal: 0x80ddad,
  selected: 0xf1c75b,
  warning: 0xff8173,
};

/** Draws only the supplied seat snapshot; never loads a game or authoritative state. */
export class PixiTableRenderer implements TableRenderer<HTMLElement> {
  private app: Application | undefined;
  private host: HTMLElement | undefined;
  private init: Init | undefined;
  private root = new Container();
  private zones = new Container();
  private pieces = new Container();
  private snapshot: TableSnapshot = EMPTY;
  private placements: PlacedItem[] = [];
  private visuals = new Map<string, Visual>();
  private selection: string[] = [];
  private gestures = new Set<(gesture: Gesture) => void>();
  private selections = new Set<(ids: string[]) => void>();
  private view: Viewport = fitViewport(EMPTY, 800, 600, null);
  private pointers = new Map<number, Pointer>();
  private press: Press | undefined;
  private dropZone: string | undefined;
  private observer: ResizeObserver | undefined;
  private abort: AbortController | undefined;
  private textures = new Map<string, Promise<Texture | null>>();
  private loaded = new Set<Texture>();
  private generation = 0;
  private mounting = false;

  async mount(container: HTMLElement, init: Init): Promise<void> {
    if (this.app || this.mounting) throw new Error("Table renderer is already mounted");
    const components = ComponentsFileSchema.parse(init.components);
    const generation = ++this.generation;
    this.mounting = true;
    const app = new Application();
    try {
      await app.init({
        width: Math.max(1, container.clientWidth),
        height: Math.max(1, container.clientHeight),
        background: 0x15392f,
        antialias: true,
        autoDensity: true,
        resolution: Math.min(3, window.devicePixelRatio || 1),
        preference: "webgl",
      });
    } catch (error) {
      this.mounting = false;
      throw error;
    }
    this.mounting = false;
    if (generation !== this.generation) {
      app.destroy(true, { children: true });
      return;
    }
    this.app = app;
    this.host = container;
    this.init = { ...init, components };
    this.root = new Container();
    this.zones = new Container();
    this.pieces = new Container();
    this.root.addChild(this.zones, this.pieces);
    app.stage.addChild(this.root);
    app.canvas.style.touchAction = "none";
    app.canvas.style.display = "block";
    app.canvas.setAttribute("aria-label", "Game table");
    container.append(app.canvas);
    this.abort = new AbortController();
    const options = { signal: this.abort.signal };
    app.canvas.addEventListener("pointerdown", this.pointerDown, options);
    app.canvas.addEventListener("pointermove", this.pointerMove, options);
    app.canvas.addEventListener("pointerup", this.pointerUp, options);
    app.canvas.addEventListener("pointercancel", this.pointerCancel, options);
    app.canvas.addEventListener("wheel", this.wheel, { ...options, passive: false });
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    app.ticker.add((ticker) => this.animate(ticker.deltaMS));
    this.setSnapshot(this.snapshot);
  }

  setSnapshot(snapshot: TableSnapshot): void {
    const parsed = TableSnapshotSchema.parse(snapshot);
    const tableChanged = JSON.stringify(parsed.table) !== JSON.stringify(this.snapshot.table);
    this.snapshot = parsed;
    if (!this.app || !this.init) return;
    this.cancelPress();
    this.placements = layoutSnapshot(this.snapshot, this.init.components);
    const ids = new Set(this.placements.map((p) => p.item.id));
    for (const [id, visual] of this.visuals)
      if (!ids.has(id)) {
        visual.node.destroy({ children: true });
        this.visuals.delete(id);
      }
    for (const placement of this.placements) {
      const id = placement.item.id;
      let visual = this.visuals.get(id);
      if (!visual) {
        const node = new Container();
        node.position.set(placement.x, -placement.y);
        node.rotation = (placement.rotation * Math.PI) / 180;
        visual = { node, signature: "", revision: 0, target: placement };
        this.visuals.set(id, visual);
      }
      visual.target = placement;
      this.pieces.addChild(visual.node);
      this.drawItem(visual);
    }
    this.setSelection(this.selection);
    if (tableChanged) this.resize();
    else this.drawZones();
  }

  onGesture(handler: (gesture: Gesture) => void): () => void {
    this.gestures.add(handler);
    return () => {
      this.gestures.delete(handler);
    };
  }
  onSelectionChange(handler: (ids: string[]) => void): () => void {
    this.selections.add(handler);
    return () => {
      this.selections.delete(handler);
    };
  }
  setSelection(ids: string[]): void {
    const allowed = new Set(
      this.snapshot.items.filter((item) => item.selectable).map((item) => item.id),
    );
    const next = [...new Set(ids)].filter((id) => allowed.has(id));
    const changed = JSON.stringify(next) !== JSON.stringify(this.selection);
    this.selection = next;
    for (const visual of this.visuals.values()) this.drawItem(visual);
    if (changed) for (const handler of this.selections) handler([...next]);
  }

  resize(): void {
    if (!this.app || !this.host) return;
    const width = Math.max(1, this.host.clientWidth),
      height = Math.max(1, this.host.clientHeight);
    this.app.renderer.resize(width, height);
    this.view = fitViewport(this.snapshot, width, height, this.init?.seat ?? null);
    this.updateCamera();
    this.drawZones();
  }

  destroy(): void {
    ++this.generation;
    this.abort?.abort();
    this.observer?.disconnect();
    this.app?.stop();
    this.app?.destroy(true, { children: true });
    for (const texture of this.loaded) texture.destroy(true);
    this.loaded.clear();
    this.textures.clear();
    this.visuals.clear();
    this.pointers.clear();
    this.gestures.clear();
    this.selections.clear();
    this.app = undefined;
    this.host = undefined;
    this.init = undefined;
    this.press = undefined;
    this.selection = [];
    this.snapshot = EMPTY;
    this.placements = [];
  }

  private updateCamera(): void {
    this.root.position.set(
      this.view.width / 2 + this.view.panX,
      this.view.height / 2 + this.view.panY,
    );
    this.root.scale.set(this.view.scale);
    this.root.rotation = this.view.angle;
  }

  private drawZones(): void {
    for (const child of this.zones.removeChildren()) child.destroy({ children: true });
    const [width, height] = this.snapshot.table.size_mm;
    this.zones.addChild(
      new Graphics()
        .roundRect(-width / 2, -height / 2, width, height, 18)
        .fill(0x1c4437)
        .stroke({ color: 0x658470, width: 2 }),
    );
    for (const zone of this.snapshot.zones) {
      const r = zone.rect_mm,
        active = this.dropZone === zone.id;
      this.zones.addChild(
        new Graphics()
          .roundRect(r.x - r.w / 2, -r.y - r.h / 2, r.w, r.h, 7)
          .fill({ color: active ? 0x427f60 : 0x214c3d, alpha: 0.8 })
          .stroke({ color: active ? COLORS.legal : COLORS.line, width: active ? 3 : 1 }),
      );
      const label = this.label(zone.label ?? zone.id, 11, COLORS.muted);
      label.style.wordWrapWidth = r.w - 12;
      label.position.set(r.x, -r.y - r.h / 2 + 10);
      this.zones.addChild(label);
    }
  }

  private label(text: string, size: number, fill = COLORS.ink): Text {
    const result = new Text({
      text,
      style: {
        fontFamily: "Arial, sans-serif",
        fontSize: size,
        fill,
        align: "center",
        wordWrap: true,
        wordWrapWidth: 80,
      },
      resolution: 3,
    });
    result.anchor.set(0.5);
    return result;
  }

  private drawItem(visual: Visual): void {
    if (!this.init) return;
    const { item, width, height, count } = visual.target;
    const selected = this.selection.includes(item.id);
    const signature = JSON.stringify([item, count, selected]);
    if (signature === visual.signature) return;
    visual.signature = signature;
    const revision = ++visual.revision;
    for (const child of visual.node.removeChildren()) child.destroy({ children: true });
    const def = this.init.components.defs.find((candidate) => candidate.id === item.def);
    const back = this.init.components.defs.find(
      (candidate) => candidate.id === (item.back ?? (def?.kind === "card" ? def.back : undefined)),
    );
    const faceDown =
      !def || def.kind === "cardBack" || (def.kind === "card" && item.face === "down");
    const highlight = selected ? "selected" : item.highlight;
    const border = highlight ? COLORS[highlight] : 0xb7bea9;
    const graphics = new Graphics();
    if (def?.kind === "token" && def.shape === "circle")
      graphics.ellipse(0, 0, width / 2, height / 2);
    else if (def?.kind === "token" && def.shape === "hex")
      graphics.poly(
        Array.from({ length: 6 }, (_, index) => {
          const a = (index * Math.PI) / 3;
          return [(Math.cos(a) * width) / 2, (Math.sin(a) * height) / 2];
        }).flat(),
      );
    else
      graphics.roundRect(
        -width / 2,
        -height / 2,
        width,
        height,
        def?.kind === "card" ? (def.corner_radius_mm ?? 3) : 3,
      );
    graphics
      .fill(faceDown ? 0x294d64 : def?.kind === "die" ? (def.color ?? "#e9e1ce") : 0xe9e1ce)
      .stroke({ color: border, width: highlight ? 3 : 1 });
    visual.node.addChild(graphics);
    let asset: string | undefined;
    let caption = faceDown ? "CARD BACK" : (def?.name ?? def?.id ?? "Unknown piece");
    if (faceDown) {
      if (def?.kind === "cardBack") asset = def.image;
      else if (back?.kind === "cardBack") asset = back.image;
    } else if (def?.kind === "card") asset = def.front;
    else if (def?.kind === "token")
      asset = item.face === "down" ? (def.back ?? def.front) : def.front;
    else if (def?.kind === "board" || def?.kind === "piece") asset = def.image;
    else if (def?.kind === "die") {
      const face = def.faces?.[(item.value ?? 1) - 1] ?? String(item.value ?? 1);
      if (/\.(png|jpe?g|webp|avif)$/i.test(face)) asset = face;
      else caption = face;
    }
    const label = this.label(
      caption,
      def?.kind === "die" ? width * 0.6 : Math.min(11, width / 5),
      faceDown ? COLORS.ink : 0x234434,
    );
    label.style.wordWrapWidth = width - 8;
    visual.node.addChild(label);
    if (asset) {
      void this.texture(asset).then((texture) => {
        if (!texture || visual.node.destroyed || revision !== visual.revision) return;
        const sprite = new Sprite(texture);
        sprite.anchor.set(0.5);
        const scale = Math.min((width - 5) / texture.width, (height - 5) / texture.height);
        sprite.scale.set(scale);
        visual.node.addChildAt(sprite, 1);
        label.visible = false;
      });
    }
    if (item.badge || count > 1) {
      const badge = this.label(item.badge ?? String(count), 12, 0x15392f);
      badge.position.set(width / 2 - 3, -height / 2 + 3);
      visual.node.addChild(
        new Graphics().circle(badge.x, badge.y, 10).fill(COLORS.selected),
        badge,
      );
    }
  }

  private texture(ref: string): Promise<Texture | null> {
    const cached = this.textures.get(ref);
    if (cached) return cached;
    const generation = this.generation;
    const promise = new Promise<Texture | null>((resolve) => {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.onload = () => {
        if (generation !== this.generation) {
          resolve(null);
          return;
        }
        const texture = Texture.from(image);
        this.loaded.add(texture);
        resolve(texture);
      };
      image.onerror = () => resolve(null);
      try {
        image.src = this.init?.assetUrl(ref) ?? "";
      } catch {
        resolve(null);
      }
    });
    this.textures.set(ref, promise);
    return promise;
  }

  private animate(delta: number): void {
    const factor = 1 - Math.exp(-Math.min(delta, 64) / 55);
    for (const visual of this.visuals.values()) {
      if (this.press?.moved && this.press.item?.item.id === visual.target.item.id) continue;
      const { node, target } = visual;
      node.x += (target.x - node.x) * factor;
      node.y += (-target.y - node.y) * factor;
      const angle = (target.rotation * Math.PI) / 180;
      const difference = Math.atan2(
        Math.sin(angle - node.rotation),
        Math.cos(angle - node.rotation),
      );
      node.rotation += difference * factor;
    }
  }

  private point(event: PointerEvent | WheelEvent): Pointer {
    const rect = this.app?.canvas.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  }
  private emit(gesture: Gesture): void {
    for (const handler of this.gestures) handler(gesture);
  }
  private cancelPress(): void {
    this.press = undefined;
    this.dropZone = undefined;
  }
  private pointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const point = this.point(event);
    this.pointers.set(event.pointerId, point);
    this.app?.canvas.setPointerCapture(event.pointerId);
    if (this.pointers.size > 1) {
      this.cancelPress();
      return;
    }
    const [x, y] = screenToTable(point.x, point.y, this.view);
    const current = this.placements.map((placement) => {
      const node = this.visuals.get(placement.item.id)?.node;
      return node
        ? { ...placement, x: node.x, y: -node.y, rotation: (node.rotation * 180) / Math.PI }
        : placement;
    });
    const item = hitItem(current, x, y);
    this.press = { ...point, moved: false, ...(item ? { item } : {}) };
  };
  private pointerMove = (event: PointerEvent): void => {
    const previous = this.pointers.get(event.pointerId);
    if (!previous) return;
    const point = this.point(event);
    if (this.pointers.size === 2) {
      const other = [...this.pointers.entries()].find(([id]) => id !== event.pointerId)?.[1];
      if (other) {
        const oldDistance = Math.hypot(previous.x - other.x, previous.y - other.y);
        const distance = Math.hypot(point.x - other.x, point.y - other.y);
        const oldCenter = { x: (previous.x + other.x) / 2, y: (previous.y + other.y) / 2 };
        const center = { x: (point.x + other.x) / 2, y: (point.y + other.y) / 2 };
        this.zoomAt(oldDistance > 0 ? distance / oldDistance : 1, oldCenter, center);
      }
    } else if (this.press) {
      if (Math.hypot(point.x - this.press.x, point.y - this.press.y) > 6) this.press.moved = true;
      if (this.press.moved) {
        if (this.press.item?.item.draggable) {
          const [x, y] = screenToTable(point.x, point.y, this.view);
          this.visuals.get(this.press.item.item.id)?.node.position.set(x, -y);
          const zone = hitZone(this.snapshot, x, y);
          const next = zone?.droppable ? zone.id : undefined;
          if (next !== this.dropZone) {
            this.dropZone = next;
            this.drawZones();
          }
        } else if (!this.press.item) {
          this.view.panX += point.x - previous.x;
          this.view.panY += point.y - previous.y;
          this.updateCamera();
        }
      }
    }
    this.pointers.set(event.pointerId, point);
  };
  private pointerUp = (event: PointerEvent): void => {
    const press = this.press;
    const wasSingle = this.pointers.size === 1;
    this.pointers.delete(event.pointerId);
    if (wasSingle && press) {
      const point = this.point(event),
        [x, y] = screenToTable(point.x, point.y, this.view);
      if (press.moved && press.item?.item.draggable) {
        const gesture = dropGesture(this.snapshot, this.placements, press.item.item, x, y);
        if (gesture) this.emit(gesture);
      } else if (!press.moved) {
        if (press.item) {
          const item = press.item.item;
          this.emit({ kind: "click", item: item.id });
          if (item.selectable)
            this.setSelection(
              this.selection.includes(item.id)
                ? this.selection.filter((id) => id !== item.id)
                : [...this.selection, item.id],
            );
        } else {
          const zone = hitZone(this.snapshot, x, y);
          if (zone) this.emit({ kind: "clickZone", zone: zone.id });
        }
      }
    }
    this.cancelPress();
    this.drawZones();
  };
  private pointerCancel = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    this.cancelPress();
    this.drawZones();
  };
  private zoomAt(factor: number, before: Pointer, after = before): void {
    const previous = this.view.scale;
    this.view.scale = Math.max(0.05, Math.min(8, previous * factor));
    const ratio = this.view.scale / previous;
    this.view.panX =
      after.x - this.view.width / 2 - (before.x - this.view.width / 2 - this.view.panX) * ratio;
    this.view.panY =
      after.y - this.view.height / 2 - (before.y - this.view.height / 2 - this.view.panY) * ratio;
    this.updateCamera();
  }
  private wheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.zoomAt(Math.exp(-event.deltaY / 500), this.point(event));
  };
}
