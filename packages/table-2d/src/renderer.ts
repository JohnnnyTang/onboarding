import type {
  AssetRef,
  ComponentDef,
  ComponentsFile,
  Gesture,
  ItemPlacement,
  SeatId,
  TableRenderer,
  TableSnapshot,
} from "@bgp/schema";
import { ComponentsFileSchema, TableSnapshotSchema } from "@bgp/schema";
import { Application, Color, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
// Replaces PixiJS's generated shader code (`new Function`) so the web app's content
// security policy needs no 'unsafe-eval' (T20).
import "pixi.js/unsafe-eval";
import type { PlacedItem, Viewport } from "./layout.js";
import {
  type DropTarget,
  dropGesture,
  fitViewport,
  focusOrder,
  hitItem,
  hitZone,
  keyboardDropTargets,
  layoutSnapshot,
  screenToTable,
} from "./layout.js";

type Init = { components: ComponentsFile; assetUrl(ref: AssetRef): string; seat: SeatId | null };
type Shape = "rect" | "circle" | "hex";
interface Visual {
  node: Container;
  shadow: Graphics;
  ring: Graphics;
  badge: Text | undefined;
  shape: Shape;
  radius: number;
  depth: number;
  lift: number;
  signature: string;
  ringSignature: string;
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
  surround: 0x15392f,
  felt: 0x1c4437,
  rim: 0x658470,
  grid: 0xd5eadf,
  zone: 0x214c3d,
  zoneTarget: 0x2f6a52,
  ink: 0xe9e1ce,
  muted: 0x9dbcaf,
  line: 0x416256,
  paper: 0xe9e1ce,
  edge: 0xb7bea9,
  cardBack: 0x294d64,
  cardBackEdge: 0x1f3d50,
  paperEdge: 0xcbc3ad,
  dark: 0x16271f,
  shadow: 0x04100b,
  legal: 0x80ddad,
  selected: 0xf1c75b,
  warning: 0xff8173,
};
/** Pip positions on a 3 × 3 grid for numeric d6 faces. */
const PIPS: Record<string, [number, number][]> = {
  "1": [[0, 0]],
  "2": [
    [-1, -1],
    [1, 1],
  ],
  "3": [
    [-1, -1],
    [0, 0],
    [1, 1],
  ],
  "4": [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ],
  "5": [
    [-1, -1],
    [1, -1],
    [0, 0],
    [-1, 1],
    [1, 1],
  ],
  "6": [
    [-1, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [1, 1],
  ],
};
const LIFT_SCALE = 0.06;
/** Frames with nothing moving before the ticker stops; the last of them is still drawn. */
const SETTLED_FRAMES = 3;
/** Remaining distance (table units) or angle (radians) below which a piece snaps into place. */
const SNAP = 0.05;
/** DOM events on the canvas that can change what is drawn. */
const WAKE_EVENTS = [
  "pointerdown",
  "pointermove",
  "pointerup",
  "pointercancel",
  "pointerleave",
  "wheel",
  "keydown",
  "blur",
] as const;
const ZOOM_STEP = 1.2;

function shapeOf(def: ComponentDef | undefined): Shape {
  if (def?.kind === "token" && def.shape === "circle") return "circle";
  if (def?.kind === "token" && def.shape === "hex") return "hex";
  return "rect";
}
function trace(g: Graphics, shape: Shape, width: number, height: number, radius: number) {
  if (shape === "circle") return g.ellipse(0, 0, width / 2, height / 2);
  if (shape === "hex")
    return g.poly(
      Array.from({ length: 6 }, (_, index) => {
        const a = (index * Math.PI) / 3;
        return [(Math.cos(a) * width) / 2, (Math.sin(a) * height) / 2];
      }).flat(),
    );
  return g.roundRect(-width / 2, -height / 2, width, height, radius);
}
function isInteractive(item: ItemPlacement): boolean {
  return Boolean(item.selectable || item.draggable);
}

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
  private hover: string | undefined;
  private focus: string | undefined;
  private keyboard = false;
  /** Keyboard drag and drop: the carried piece and the drop targets it can cycle through. */
  private carry: { item: string; targets: DropTarget[]; at: number } | undefined;
  private observer: ResizeObserver | undefined;
  private abort: AbortController | undefined;
  private textures = new Map<string, Promise<Texture | null>>();
  private loaded = new Set<Texture>();
  private generation = 0;
  private mounting = false;
  private settled = 0;

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
        background: COLORS.surround,
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
    app.canvas.tabIndex = 0;
    app.canvas.setAttribute("role", "application");
    app.canvas.setAttribute("aria-roledescription", "game table");
    app.canvas.setAttribute("aria-label", "Game table");
    app.canvas.setAttribute("aria-keyshortcuts", "ArrowLeft ArrowRight Enter Space M Escape + - 0");
    container.append(app.canvas);
    this.abort = new AbortController();
    const options = { signal: this.abort.signal };
    // Registered first, so a handler's changes are drawn by the restarted ticker.
    for (const type of WAKE_EVENTS) app.canvas.addEventListener(type, this.wake, options);
    app.canvas.addEventListener("pointerdown", this.pointerDown, options);
    app.canvas.addEventListener("pointermove", this.pointerMove, options);
    app.canvas.addEventListener("pointerup", this.pointerUp, options);
    app.canvas.addEventListener("pointercancel", this.pointerCancel, options);
    app.canvas.addEventListener("pointerleave", this.pointerLeave, options);
    app.canvas.addEventListener("wheel", this.wheel, { ...options, passive: false });
    app.canvas.addEventListener("keydown", this.keyDown, options);
    app.canvas.addEventListener("blur", this.blur, options);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    app.ticker.add((ticker) => this.animate(ticker.deltaMS));
    this.setSnapshot(this.snapshot);
  }

  setSnapshot(snapshot: TableSnapshot): void {
    const parsed = TableSnapshotSchema.parse(snapshot);
    this.wake();
    const tableChanged = JSON.stringify(parsed.table) !== JSON.stringify(this.snapshot.table);
    this.snapshot = parsed;
    if (!this.app || !this.init) return;
    this.cancelPress();
    this.carry = undefined;
    this.placements = layoutSnapshot(this.snapshot, this.init.components);
    const ids = new Set(this.placements.map((p) => p.item.id));
    for (const [id, visual] of this.visuals)
      if (!ids.has(id)) {
        visual.node.destroy({ children: true });
        this.visuals.delete(id);
      }
    if (this.hover && !ids.has(this.hover)) this.hover = undefined;
    if (this.focus && !ids.has(this.focus)) this.setFocus(undefined);
    for (const placement of this.placements) {
      const id = placement.item.id;
      let visual = this.visuals.get(id);
      if (!visual) {
        const node = new Container();
        node.position.set(placement.x, -placement.y);
        node.rotation = (placement.rotation * Math.PI) / 180;
        visual = {
          node,
          shadow: new Graphics(),
          ring: new Graphics(),
          badge: undefined,
          shape: "rect",
          radius: 3,
          depth: 0,
          lift: 0,
          signature: "",
          ringSignature: "",
          revision: 0,
          target: placement,
        };
        this.visuals.set(id, visual);
      }
      visual.target = placement;
      this.pieces.addChild(visual.node);
      this.drawItem(visual);
    }
    this.restack();
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
    this.wake();
    const allowed = new Set(
      this.snapshot.items.filter((item) => item.selectable).map((item) => item.id),
    );
    const next = [...new Set(ids)].filter((id) => allowed.has(id));
    const changed = JSON.stringify(next) !== JSON.stringify(this.selection);
    this.selection = next;
    for (const visual of this.visuals.values()) this.drawRing(visual);
    if (changed) {
      this.describeFocus();
      for (const handler of this.selections) handler([...next]);
    }
  }

  resize(): void {
    if (!this.app || !this.host) return;
    this.wake();
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
    this.hover = undefined;
    this.focus = undefined;
    this.keyboard = false;
    this.carry = undefined;
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

  private dragged(): PlacedItem | undefined {
    return this.press?.moved && this.press.item?.item.draggable ? this.press.item : undefined;
  }

  private drawZones(): void {
    for (const child of this.zones.removeChildren()) child.destroy({ children: true });
    const [width, height] = this.snapshot.table.size_mm;
    const dragging = Boolean(this.dragged()) || this.carry !== undefined;
    this.zones.addChild(
      new Graphics()
        .roundRect(-width / 2, -height / 2, width, height, 18)
        .fill(COLORS.felt)
        .stroke({ color: COLORS.rim, width: 2 }),
    );
    // A faint 50 mm grid, like a cutting mat, keeps table coordinates readable.
    const grid = new Graphics();
    for (let offset = 50; offset < width / 2 - 18; offset += 50)
      for (const x of [-offset, offset]) grid.moveTo(x, 2 - height / 2).lineTo(x, height / 2 - 2);
    for (let offset = 50; offset < height / 2 - 18; offset += 50)
      for (const y of [-offset, offset]) grid.moveTo(2 - width / 2, y).lineTo(width / 2 - 2, y);
    grid.stroke({ color: COLORS.grid, width: 0.6, alpha: 0.07 });
    grid
      .moveTo(0, 2 - height / 2)
      .lineTo(0, height / 2 - 2)
      .moveTo(2 - width / 2, 0)
      .lineTo(width / 2 - 2, 0)
      .stroke({ color: COLORS.grid, width: 0.8, alpha: 0.12 });
    this.zones.addChild(grid);
    for (const zone of this.snapshot.zones) {
      const r = zone.rect_mm,
        active = this.dropZone === zone.id,
        target = dragging && zone.droppable,
        turn = ((zone.rotation_deg ?? 0) * Math.PI) / 180;
      // The area turns with its zone (side seats); the label stays upright for the viewer.
      const area = new Graphics().roundRect(-r.w / 2, -r.h / 2, r.w, r.h, 7).fill({
        color: active ? COLORS.zoneTarget : COLORS.zone,
        alpha: active ? 0.95 : dragging && !target ? 0.45 : 0.75,
      });
      if (active) area.stroke({ color: COLORS.legal, width: 3 });
      else if (target) area.stroke({ color: COLORS.legal, width: 1.5, alpha: 0.55 });
      else area.stroke({ color: COLORS.line, width: 1 });
      area.position.set(r.x, -r.y);
      area.rotation = turn;
      this.zones.addChild(area);
      const seen = this.view.angle + turn;
      const label = this.label(zone.label ?? zone.id, 10, active ? COLORS.legal : COLORS.muted, {
        align: "left",
        wrap: Math.abs(Math.cos(seen)) * r.w + Math.abs(Math.sin(seen)) * r.h - 14,
      });
      label.anchor.set(0, 0);
      this.uprightLabel(label, r, turn);
      this.zones.addChild(label);
    }
  }

  /** Zone names are interface text: keep them upright in the top-left corner the seat sees. */
  private uprightLabel(
    label: Text,
    r: { x: number; y: number; w: number; h: number },
    turn = 0,
  ): void {
    const c = Math.cos(this.view.angle),
      s = Math.sin(this.view.angle),
      tc = Math.cos(turn),
      ts = Math.sin(turn);
    // Corners of the zone after its own rotation about its centre, in table-layer coordinates.
    const corners = [
      [-r.w / 2, -r.h / 2],
      [r.w / 2, -r.h / 2],
      [-r.w / 2, r.h / 2],
      [r.w / 2, r.h / 2],
    ]
      .map(([dx = 0, dy = 0]) => ({ x: r.x + dx * tc - dy * ts, y: -r.y + dx * ts + dy * tc }))
      .map(({ x, y }) => ({ x, y, sx: x * c - y * s, sy: x * s + y * c }));
    const corner = corners.sort((a, b) => Math.round(a.sy - b.sy) || a.sx - b.sx)[0];
    if (!corner) return;
    label.rotation = -this.view.angle;
    label.position.set(corner.x + 7 * c + 5 * s, corner.y - 7 * s + 5 * c);
  }

  private label(
    text: string,
    size: number,
    fill = COLORS.ink,
    { align = "center", wrap = 80 }: { align?: "left" | "center"; wrap?: number } = {},
  ): Text {
    const result = new Text({
      text,
      style: {
        fontFamily: "Arial, sans-serif",
        fontSize: size,
        fill,
        align,
        wordWrap: true,
        wordWrapWidth: Math.max(1, wrap),
      },
      resolution: 3,
    });
    result.anchor.set(0.5);
    return result;
  }

  private def(id: string | undefined): ComponentDef | undefined {
    return id === undefined
      ? undefined
      : this.init?.components.defs.find((candidate) => candidate.id === id);
  }

  /** What the viewing seat can say about an item: its name when visible, otherwise "Card back". */
  private caption(item: ItemPlacement): string {
    const def = this.def(item.def);
    if (!def || def.kind === "cardBack" || (def.kind === "card" && item.face === "down"))
      return "Card back";
    return def.name ?? def.id;
  }

  private drawItem(visual: Visual): void {
    if (!this.init) return;
    const { item, width, height, count } = visual.target;
    const signature = JSON.stringify([item, count, width, height]);
    if (signature === visual.signature) return;
    visual.signature = signature;
    visual.ringSignature = "";
    const revision = ++visual.revision;
    for (const child of visual.node.removeChildren()) child.destroy({ children: true });
    const def = this.def(item.def);
    const back = this.def(item.back ?? (def?.kind === "card" ? def.back : undefined));
    const faceDown =
      !def || def.kind === "cardBack" || (def.kind === "card" && item.face === "down");
    const shape = shapeOf(def);
    const radius = def?.kind === "card" ? (def.corner_radius_mm ?? 3) : 3;
    const depth = Math.min(3, count - 1);
    visual.shape = shape;
    visual.radius = radius;
    visual.depth = depth;
    visual.badge = undefined;
    visual.shadow = trace(new Graphics(), shape, width, height, radius).fill({
      color: COLORS.shadow,
      alpha: 0.32,
    });
    visual.node.addChild(visual.shadow);
    // Stacks show up to three card edges beneath the top card so depth reads at a glance.
    for (let layer = depth; layer > 0; layer--) {
      const edge = trace(new Graphics(), shape, width, height, radius)
        .fill(faceDown ? COLORS.cardBackEdge : COLORS.paperEdge)
        .stroke({ color: COLORS.edge, width: 0.8, alpha: 0.7 });
      edge.position.set(layer * 0.8, layer * 1.6);
      visual.node.addChild(edge);
    }
    const border = item.highlight ? COLORS[item.highlight] : COLORS.edge;
    const fill = faceDown
      ? COLORS.cardBack
      : def?.kind === "die"
        ? (def.color ?? COLORS.paper)
        : COLORS.paper;
    visual.node.addChild(
      trace(new Graphics(), shape, width, height, radius)
        .fill(fill)
        .stroke({ color: border, width: item.highlight ? 3 : 1 }),
    );
    const art = new Container();
    visual.node.addChild(art);
    let asset: string | undefined;
    let caption = this.caption(item);
    let pips: [number, number][] | undefined;
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
      else {
        caption = face;
        if (def.sides === 6) pips = PIPS[face];
      }
    }
    if (pips && def?.kind === "die") {
      const ink = new Color(def.color ?? COLORS.paper).toRgb();
      const light = 0.299 * ink.r + 0.587 * ink.g + 0.114 * ink.b > 0.5;
      const dots = new Graphics();
      for (const [px, py] of pips) dots.circle(px * width * 0.26, py * height * 0.26, width * 0.09);
      visual.node.addChild(dots.fill(light ? COLORS.dark : COLORS.paper));
    }
    const label = this.label(
      caption,
      def?.kind === "die" ? width * 0.6 : Math.min(11, width / 5),
      faceDown ? COLORS.ink : COLORS.dark,
      { wrap: width - 8 },
    );
    label.visible = !pips;
    visual.node.addChild(label);
    if (asset) {
      void this.texture(asset).then((texture) => {
        if (!texture || visual.node.destroyed || revision !== visual.revision) return;
        this.wake();
        const sprite = new Sprite(texture);
        sprite.anchor.set(0.5);
        const scale = Math.min((width - 5) / texture.width, (height - 5) / texture.height);
        sprite.scale.set(scale);
        art.addChild(sprite);
        if (shape !== "rect") {
          // Round and hex tokens clip their art to the token outline.
          const mask = trace(new Graphics(), shape, width - 2, height - 2, radius).fill(0xffffff);
          art.addChild(mask);
          sprite.mask = mask;
        }
        label.visible = false;
      });
    }
    visual.ring = new Graphics();
    visual.node.addChild(visual.ring);
    this.drawRing(visual);
    if (item.badge || count > 1) {
      const badge = this.label(item.badge ?? String(count), 11, COLORS.dark);
      badge.position.set(width / 2 - 3, -height / 2 + 3);
      visual.badge = badge;
      visual.node.addChild(
        new Graphics()
          .circle(badge.x, badge.y, 9.5)
          .fill(COLORS.paper)
          .stroke({ color: COLORS.dark, width: 1.2 }),
        badge,
      );
    }
  }

  /** Selection, hover and keyboard focus outlines; redrawn without rebuilding the piece. */
  private drawRing(visual: Visual): void {
    const { item, width, height } = visual.target;
    const selected = this.selection.includes(item.id);
    const focused = this.keyboard && this.focus === item.id;
    const hovered = (this.hover === item.id && !this.dragged()) || this.carryTarget() === item.id;
    const signature = `${selected}${focused}${hovered}`;
    if (signature === visual.ringSignature || visual.ring.destroyed) return;
    visual.ringSignature = signature;
    const { ring, shape, radius } = visual;
    ring.clear();
    const outline = (outset: number) =>
      trace(ring, shape, width + outset * 2, height + outset * 2, radius + outset);
    if (selected) outline(0).stroke({ color: COLORS.selected, width: 3 });
    if (focused) {
      outline(4.5).stroke({ color: COLORS.dark, width: 4 });
      outline(4.5).stroke({ color: 0xffffff, width: 1.8 });
    } else if (hovered)
      outline(selected ? 3.5 : 2).stroke({ color: 0xffffff, width: 1.4, alpha: 0.75 });
  }
  private refreshRing(id: string | undefined): void {
    const visual = id === undefined ? undefined : this.visuals.get(id);
    if (visual) this.drawRing(visual);
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

  /**
   * Restarts drawing after a change. While nothing moves the ticker is stopped, so an idle
   * table costs no frames (several tables can share one device, and phones save battery).
   */
  private wake = (): void => {
    this.settled = 0;
    if (this.app && !this.app.ticker.started) this.app.ticker.start();
  };

  private animate(delta: number): void {
    const step = Math.min(delta, 64);
    const factor = 1 - Math.exp(-step / 55);
    const quick = 1 - Math.exp(-step / 35);
    const dragged = this.dragged()?.item.id;
    let moving = this.press !== undefined || this.pointers.size > 0;
    for (const visual of this.visuals.values()) {
      const { node, target } = visual;
      const lifted = target.item.id === dragged;
      visual.lift += ((lifted ? 1 : 0) - visual.lift) * quick;
      if (Math.abs(visual.lift) < 0.001) visual.lift = 0;
      else moving = true;
      node.scale.set(1 + LIFT_SCALE * visual.lift);
      if (!lifted) {
        const angle = (target.rotation * Math.PI) / 180;
        const difference = Math.atan2(
          Math.sin(angle - node.rotation),
          Math.cos(angle - node.rotation),
        );
        const dx = target.x - node.x;
        const dy = -target.y - node.y;
        if (Math.abs(dx) < SNAP && Math.abs(dy) < SNAP && Math.abs(difference) < SNAP / 10) {
          node.position.set(target.x, -target.y);
          node.rotation = angle;
        } else {
          moving = true;
          node.x += dx * factor;
          node.y += dy * factor;
          node.rotation += difference * factor;
        }
      }
      // Light comes from the top left of the table; lifted pieces cast a longer, softer shadow.
      const ox = 1.2 + 4 * visual.lift,
        oy = 2 + 6 * visual.lift;
      const c = Math.cos(-node.rotation),
        s = Math.sin(-node.rotation);
      visual.shadow.position.set(
        visual.depth * 0.8 + ox * c - oy * s,
        visual.depth * 1.6 + ox * s + oy * c,
      );
      visual.shadow.alpha = 1 - 0.3 * visual.lift;
      // Counts are interface text: keep them upright whatever the seat or card angle.
      if (visual.badge) visual.badge.rotation = -(this.view.angle + node.rotation);
    }
    this.settled = moving ? 0 : this.settled + 1;
    // Stopping inside the tick still renders this frame.
    if (this.settled >= SETTLED_FRAMES) this.app?.ticker.stop();
  }

  private point(event: PointerEvent | WheelEvent): Pointer {
    const rect = this.app?.canvas.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  }
  /** Hit-tests against where pieces are drawn now, including mid-animation. */
  private itemAt(point: Pointer): PlacedItem | undefined {
    const [x, y] = screenToTable(point.x, point.y, this.view);
    const current = this.placements.map((placement) => {
      const node = this.visuals.get(placement.item.id)?.node;
      return node
        ? { ...placement, x: node.x, y: -node.y, rotation: (node.rotation * 180) / Math.PI }
        : placement;
    });
    return hitItem(current, x, y);
  }
  private emit(gesture: Gesture): void {
    for (const handler of this.gestures) handler(gesture);
  }
  private cursor(value: string): void {
    if (this.app) this.app.canvas.style.cursor = value;
  }
  private setHover(placement: PlacedItem | undefined): void {
    const item = placement && isInteractive(placement.item) ? placement.item : undefined;
    this.cursor(item?.draggable ? "grab" : item ? "pointer" : "");
    if (item?.id === this.hover) return;
    const previous = this.hover;
    this.hover = item?.id;
    this.refreshRing(previous);
    this.refreshRing(this.hover);
  }
  private setFocus(id: string | undefined): void {
    const previous = this.focus;
    this.focus = id;
    this.refreshRing(previous);
    this.refreshRing(id);
    this.restack();
    this.describeFocus();
  }
  /** Keeps the canvas name in step with the focused piece for screen readers. */
  private describeFocus(): void {
    if (!this.app) return;
    if (this.carry) {
      this.app.canvas.setAttribute("aria-label", `Game table: ${this.describeCarry(this.carry)}`);
      return;
    }
    const placement = this.placements.find((p) => p.item.id === this.focus);
    if (!placement) {
      this.app.canvas.setAttribute("aria-label", "Game table");
      return;
    }
    const zone = this.snapshot.zones.find((z) => z.id === placement.item.zone);
    const parts = [this.caption(placement.item), `in ${zone?.label ?? placement.item.zone}`];
    if (placement.count > 1) parts.push(`${placement.count} in stack`);
    if (this.selection.includes(placement.item.id)) parts.push("selected");
    this.app.canvas.setAttribute("aria-label", `Game table: ${parts.join(", ")}`);
  }
  private describeCarry(carry: NonNullable<typeof this.carry>): string {
    const carried = this.snapshot.items.find((item) => item.id === carry.item);
    const target = carry.targets[carry.at];
    if (!carried || !target) return "Game table";
    const zone = this.snapshot.zones.find((z) => z.id === target.gesture.to);
    const label = zone?.label ?? target.gesture.to;
    const onto =
      target.at === undefined ? undefined : this.snapshot.items.find((i) => i.id === target.at);
    const others = this.snapshot.items.filter(
      (i) => i.zone === target.gesture.to && i.id !== carry.item,
    );
    let where = label;
    if (onto) where = `${this.caption(onto)}, in ${label}`;
    else if (zone?.layout === "stack" && others.length > 0) where = `top of ${label}`;
    else if (zone?.layout !== "free" && others.length > 0) where = `end of ${label}`;
    return `moving ${this.caption(carried)} to ${where} (${carry.at + 1} of ${carry.targets.length}); Enter drops, Escape cancels`;
  }
  private carryTarget(): string | undefined {
    return this.carry?.targets[this.carry.at]?.at;
  }
  /** Picks up the focused piece (M): arrow keys then choose where it goes. */
  private startCarry(): void {
    const placement = this.placements.find((p) => p.item.id === this.focus);
    if (!placement?.item.draggable) return;
    const targets = keyboardDropTargets(this.snapshot, this.placements, placement.item, this.view);
    if (targets.length === 0) return;
    // Start with the first place elsewhere: moving within its own zone is the rarer case.
    const elsewhere = targets.findIndex((target) => target.gesture.to !== placement.item.zone);
    this.carry = { item: placement.item.id, targets, at: Math.max(0, elsewhere) };
    this.showCarry(undefined);
  }
  private moveCarry(step: 1 | -1): void {
    if (!this.carry) return;
    const previous = this.carryTarget();
    const count = this.carry.targets.length;
    this.carry.at = (this.carry.at + step + count) % count;
    this.showCarry(previous);
  }
  private showCarry(previousTarget: string | undefined): void {
    this.dropZone = this.carry?.targets[this.carry.at]?.gesture.to;
    this.drawZones();
    this.refreshRing(previousTarget);
    this.refreshRing(this.carryTarget());
    this.describeFocus();
  }
  /** Ends a carry; with `drop`, emits the chosen drop like a pointer drop there would. */
  private endCarry(drop: boolean): void {
    const carry = this.carry;
    if (!carry) return;
    const target = carry.targets[carry.at];
    this.carry = undefined;
    this.showCarry(target?.at);
    if (drop && target) this.emit(target.gesture);
  }
  private activate(item: ItemPlacement): void {
    this.emit({ kind: "click", item: item.id });
    if (item.selectable)
      this.setSelection(
        this.selection.includes(item.id)
          ? this.selection.filter((id) => id !== item.id)
          : [...this.selection, item.id],
      );
  }
  /** Snapshot order, with the keyboard-focused piece and then the dragged piece on top. */
  private restack(): void {
    for (const placement of this.placements) {
      const node = this.visuals.get(placement.item.id)?.node;
      if (node) this.pieces.addChild(node);
    }
    for (const id of [this.keyboard ? this.focus : undefined, this.dragged()?.item.id]) {
      const node = id === undefined ? undefined : this.visuals.get(id)?.node;
      if (node) this.pieces.addChild(node);
    }
  }
  private cancelPress(): void {
    const wasDragging = Boolean(this.dragged());
    this.press = undefined;
    this.dropZone = undefined;
    if (wasDragging) this.restack();
  }
  private pointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    this.endCarry(false);
    if (this.keyboard) {
      this.keyboard = false;
      this.refreshRing(this.focus);
      this.restack();
    }
    const point = this.point(event);
    this.pointers.set(event.pointerId, point);
    this.app?.canvas.setPointerCapture(event.pointerId);
    if (this.pointers.size > 1) {
      this.cancelPress();
      return;
    }
    const item = this.itemAt(point);
    this.press = { ...point, moved: false, ...(item ? { item } : {}) };
  };
  private pointerMove = (event: PointerEvent): void => {
    const previous = this.pointers.get(event.pointerId);
    if (!previous) {
      if (event.pointerType === "mouse") this.setHover(this.itemAt(this.point(event)));
      return;
    }
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
      const started = !this.press.moved;
      if (Math.hypot(point.x - this.press.x, point.y - this.press.y) > 6) this.press.moved = true;
      if (this.press.moved) {
        const dragged = this.press.item?.item.draggable ? this.press.item : undefined;
        if (dragged) {
          const node = this.visuals.get(dragged.item.id)?.node;
          if (started && node) {
            // Lift the piece above its neighbours and show every zone that accepts it.
            this.restack();
            this.cursor("grabbing");
            this.refreshRing(dragged.item.id);
            this.drawZones();
          }
          const [x, y] = screenToTable(point.x, point.y, this.view);
          node?.position.set(x, -y);
          const zone = hitZone(this.snapshot, x, y);
          const next = zone?.droppable ? zone.id : undefined;
          if (next !== this.dropZone) {
            this.dropZone = next;
            this.drawZones();
          }
        } else if (!this.press.item) {
          if (started) this.cursor("grabbing");
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
    const point = this.point(event);
    if (wasSingle && press) {
      const [x, y] = screenToTable(point.x, point.y, this.view);
      if (press.moved && press.item?.item.draggable) {
        const gesture = dropGesture(this.snapshot, this.placements, press.item.item, x, y);
        if (gesture) this.emit(gesture);
      } else if (!press.moved) {
        if (press.item) this.activate(press.item.item);
        else {
          const zone = hitZone(this.snapshot, x, y);
          if (zone) this.emit({ kind: "clickZone", zone: zone.id });
        }
      }
    }
    this.cancelPress();
    this.drawZones();
    this.refreshRing(press?.item?.item.id);
    if (event.pointerType === "mouse") this.setHover(this.itemAt(point));
    else this.cursor("");
  };
  private pointerCancel = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    this.cancelPress();
    this.drawZones();
    this.cursor("");
  };
  private pointerLeave = (event: PointerEvent): void => {
    if (!this.pointers.has(event.pointerId)) this.setHover(undefined);
  };
  private blur = (): void => {
    this.endCarry(false);
    if (!this.keyboard) return;
    this.keyboard = false;
    this.refreshRing(this.focus);
    this.restack();
  };
  private moveFocus(step: 1 | -1): void {
    const order = focusOrder(this.snapshot, this.placements, this.view);
    if (order.length === 0) return;
    const at = this.focus === undefined ? -1 : order.indexOf(this.focus);
    const next =
      at < 0 ? (step > 0 ? 0 : order.length - 1) : (at + step + order.length) % order.length;
    this.keyboard = true;
    this.setFocus(order[next]);
  }
  private keyDown = (event: KeyboardEvent): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (this.carry && this.carryKey(event.key)) {
      event.preventDefault();
      return;
    }
    const center = { x: this.view.width / 2, y: this.view.height / 2 };
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        this.moveFocus(1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        this.moveFocus(-1);
        break;
      case "Enter":
      case " ": {
        const placement = this.placements.find((p) => p.item.id === this.focus);
        if (!placement) return;
        if (this.keyboard) this.activate(placement.item);
        else {
          // After pointer use the focus ring is hidden; reveal it before acting on it.
          this.keyboard = true;
          this.refreshRing(this.focus);
          this.restack();
        }
        break;
      }
      case "m":
      case "M":
        if (!this.focus) return;
        if (!this.keyboard) {
          this.keyboard = true;
          this.refreshRing(this.focus);
          this.restack();
        }
        this.startCarry();
        break;
      case "Escape":
        if (this.selection.length === 0) return;
        this.setSelection([]);
        break;
      case "+":
      case "=":
        this.zoomAt(ZOOM_STEP, center);
        break;
      case "-":
        this.zoomAt(1 / ZOOM_STEP, center);
        break;
      case "0":
        this.resize();
        break;
      default:
        return;
    }
    event.preventDefault();
  };
  /** Keys while carrying a piece; others (zoom) fall through. Returns whether it was handled. */
  private carryKey(key: string): boolean {
    switch (key) {
      case "ArrowRight":
      case "ArrowDown":
        this.moveCarry(1);
        return true;
      case "ArrowLeft":
      case "ArrowUp":
        this.moveCarry(-1);
        return true;
      case "Enter":
      case " ":
        this.endCarry(true);
        return true;
      case "Escape":
      case "m":
      case "M":
        this.endCarry(false);
        return true;
      default:
        return false;
    }
  }
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
