import {
  type ActionButton,
  type ClientView,
  type ComponentsFile,
  ComponentsFileSchema,
  type GameDefinition,
  type Gesture,
  JsonSchema,
  type ManualOp,
  ManualOpSchema,
  type MoveContext,
  type MoveIntent,
  type PresentInfo,
  type Random,
  type SandboxState,
  type SandboxView,
  type SeatId,
  type TableSnapshot,
  type ZoneDef,
} from "@bgp/schema";
import { invalid, rekey } from "./helpers.js";

type Item = SandboxState["items"][number];
type Zone = Omit<ZoneDef, "owner"> & { owner?: SeatId };
type ViewItem = SandboxView["items"][number];

function expandZones(components: ComponentsFile, seats: SeatId[]): Zone[] {
  const zones = (components.zones ?? []).flatMap((zone): Zone[] => {
    if (zone.owner === "each") {
      return seats.map((seat) => ({ ...zone, id: `${zone.id}:${seat}`, owner: seat }));
    }
    if (zone.owner !== undefined && !seats.includes(zone.owner)) {
      throw new Error("Unknown zone owner");
    }
    return [zone as Zone];
  });
  if (zones.some((zone, index) => zones.findIndex((other) => other.id === zone.id) !== index)) {
    throw new Error("Duplicate expanded zones");
  }
  return zones;
}

function tableSize(zones: ZoneDef[]): [number, number] {
  return [
    Math.max(800, ...zones.map((zone) => Math.ceil(2 * Math.abs(zone.rect_mm.x) + zone.rect_mm.w))),
    Math.max(600, ...zones.map((zone) => Math.ceil(2 * Math.abs(zone.rect_mm.y) + zone.rect_mm.h))),
  ];
}

function ordered(state: SandboxState, zone: string): Item[] {
  return state.items.filter((item) => item.zone === zone).sort((a, b) => a.index - b.index);
}

function replaceZone(state: SandboxState, zone: string, items: Item[]): void {
  state.items = state.items.filter((item) => item.zone !== zone);
  state.items.push(...items.map((item, index) => ({ ...item, zone, index })));
}

function canonicalOrder(state: SandboxState, zones: Zone[]): void {
  state.items = zones.flatMap((zone) => ordered(state, zone.id));
}

function canTouch(zone: Zone, seat: SeatId): boolean {
  return zone.visibility !== "owner" || zone.owner === seat;
}

function shuffleZone(state: SandboxState, zone: string, random: Random): void {
  // Cosmetic marks must not let viewers associate fresh IDs with known pieces.
  const items = ordered(state, zone).map((item) => ({
    ...item,
    rotation_deg: 0,
    ...(item.pos_mm === undefined ? {} : { pos_mm: [0, 0] as [number, number] }),
  }));
  replaceZone(state, zone, rekey(random.shuffle(items), random));
}

function place(
  state: SandboxState,
  item: Item,
  zone: Zone,
  index?: number,
  pos?: [number, number],
  face?: "up" | "down",
): void {
  const sameZone = item.zone === zone.id;
  replaceZone(
    state,
    item.zone,
    ordered(state, item.zone).filter((other) => other.id !== item.id),
  );
  const items = ordered(state, zone.id);
  if (zone.layout === "free") {
    item.pos_mm = pos ??
      (sameZone ? item.pos_mm : undefined) ?? [
        Math.round(zone.rect_mm.x),
        Math.round(zone.rect_mm.y),
      ];
  } else {
    delete item.pos_mm;
  }
  if (face !== undefined) item.face = face;
  items.splice(index ?? items.length, 0, item);
  replaceZone(state, zone.id, items);
}

function validOperation(
  op: ManualOp,
  state: SandboxState,
  zones: Zone[],
  components: ComponentsFile,
  seat: SeatId,
): boolean {
  const sourceId =
    "item" in op
      ? state.items.find((item) => item.id === op.item)?.zone
      : op.op === "shuffle"
        ? op.zone
        : op.op === "deal"
          ? op.from
          : undefined;
  if (op.op === "endTurn" || op.op === "endGame") return true;
  const source = zones.find((zone) => zone.id === sourceId);
  if (!source || !canTouch(source, seat)) return false;
  if (op.op === "move") {
    const target = zones.find((zone) => zone.id === op.to);
    if (!target) return false;
    const length = ordered(state, target.id).length - (source.id === target.id ? 1 : 0);
    if (op.index !== undefined && op.index > length) return false;
    if (op.pos_mm !== undefined) {
      const size = tableSize(zones);
      if (
        target.layout !== "free" ||
        Math.abs(op.pos_mm[0]) * 2 > size[0] ||
        Math.abs(op.pos_mm[1]) * 2 > size[1]
      )
        return false;
    }
  }
  if (op.op === "deal") {
    if (
      new Set(op.to).size !== op.to.length ||
      op.to.some((id) => id === source.id || !zones.some((zone) => zone.id === id)) ||
      op.count > Math.floor(ordered(state, source.id).length / op.to.length)
    )
      return false;
  }
  if (op.op === "roll") {
    const item = state.items.find((candidate) => candidate.id === op.item);
    if (!components.defs.some((def) => def.id === item?.def && def.kind === "die")) return false;
  }
  return true;
}

function applyOperation(
  state: SandboxState,
  ctx: MoveContext,
  op: ManualOp,
  zones: Zone[],
  components: ComponentsFile,
): void {
  if (op.op === "endTurn") {
    ctx.events.endTurn();
    return;
  }
  if (op.op === "endGame") {
    ctx.events.endGame({ winners: [], reason: `Ended by ${seatName(ctx.seat)}` });
    return;
  }
  if (op.op === "shuffle") {
    shuffleZone(state, op.zone, ctx.random);
    return;
  }
  if (op.op === "deal") {
    for (let round = 0; round < op.count; round += 1) {
      for (const target of op.to) {
        const zone = zones.find((candidate) => candidate.id === target);
        const item = ordered(state, op.from).at(-1);
        if (!zone || !item) throw new Error("Invalid deal");
        place(
          state,
          item,
          zone,
          undefined,
          undefined,
          op.face ?? (zone.visibility === "owner" ? "down" : undefined),
        );
      }
    }
    return;
  }
  const item = state.items.find((candidate) => candidate.id === op.item);
  if (!item) throw new Error("Unknown item");
  switch (op.op) {
    case "move": {
      const zone = zones.find((candidate) => candidate.id === op.to);
      if (!zone) throw new Error("Unknown zone");
      place(state, item, zone, op.index, op.pos_mm, op.face);
      break;
    }
    case "flip":
      item.face = item.face === "up" ? "down" : "up";
      break;
    case "rotate":
      item.rotation_deg = op.deg;
      break;
    case "roll": {
      const def = components.defs.find((candidate) => candidate.id === item.def);
      if (def?.kind !== "die") throw new Error("Not a die");
      item.value = ctx.random.die(def.sides);
      break;
    }
  }
}

function visibleItem(
  item: Item,
  zone: Zone,
  components: ComponentsFile,
  seat: SeatId | null,
): ViewItem {
  const known = zone.visibility === "owner" ? zone.owner === seat : item.face === "up";
  const view: ViewItem = {
    id: item.id,
    zone: item.zone,
    index: item.index,
    rotation_deg: item.rotation_deg,
    face: known ? item.face : "down",
  };
  if (item.pos_mm !== undefined) view.pos_mm = [...item.pos_mm];
  if (known) {
    view.def = item.def;
    if (item.value !== undefined) view.value = item.value;
  }
  const def = components.defs.find((candidate) => candidate.id === item.def);
  if (def?.kind === "card") view.back = def.back;
  return view;
}

type View = ClientView<SandboxView>;

function manual(op: ManualOp): MoveIntent {
  // Parsing as JSON also guarantees that no optional field is present as `undefined`.
  return { move: "manual", args: JsonSchema.parse(op) };
}

/** The seat may change the table: it plays in this match and the match is not over. */
function actingSeat(view: View, info: PresentInfo): SeatId | null {
  return info.seat !== null && view.ctx.seats.includes(info.seat) && view.result === null
    ? info.seat
    : null;
}

/**
 * Gestures become manual operations: dropping an item moves it. Clicks only select, which
 * the renderer handles. Drops the seat could not make, or that change nothing, give null.
 */
function interpretGesture(
  components: ComponentsFile,
  gesture: Gesture,
  view: View,
  info: PresentInfo,
): MoveIntent | null {
  const seat = actingSeat(view, info);
  if (seat === null || gesture.kind !== "drop") return null;
  const zones = expandZones(components, view.ctx.seats);
  const item = view.game.items.find((candidate) => candidate.id === gesture.item);
  const source = zones.find((zone) => zone.id === item?.zone);
  const target = zones.find((zone) => zone.id === gesture.to);
  if (!item || !source || !target || !canTouch(source, seat)) return null;
  if (target.layout === "free") {
    if (gesture.pos_mm === undefined) return null;
    return manual({ op: "move", item: item.id, to: target.id, pos_mm: [...gesture.pos_mm] });
  }
  const others = view.game.items.filter(
    (other) => other.zone === target.id && other.id !== item.id,
  ).length;
  const index = Math.min(gesture.index ?? others, others);
  if (source.id === target.id && index === item.index) return null;
  return manual({ op: "move", item: item.id, to: target.id, index });
}

function zoneName(zone: ZoneDef | Zone): string {
  return zone.label ?? zone.id;
}

/** Seats are "0".."n-1"; people count from one. */
function seatName(seat: SeatId): string {
  return `Seat ${Number(seat) + 1}`;
}

/**
 * Buttons for one selected item: flip, rotate, roll (dice), shuffle its zone and deal from
 * it into each seat's zone of every `owner: "each"` declaration. End turn and end game are
 * always offered; ending the game asks first because it cannot be undone.
 */
function sandboxActions(
  components: ComponentsFile,
  view: View,
  info: PresentInfo,
  selection: string[],
): ActionButton[] {
  const seat = actingSeat(view, info);
  if (seat === null) return [];
  const zones = expandZones(components, view.ctx.seats);
  const endTurn: ActionButton = {
    id: "end-turn",
    label: "End turn",
    enabled: true,
    intent: manual({ op: "endTurn" }),
  };
  const endGame: ActionButton = {
    id: "end-game",
    label: "End game",
    enabled: true,
    intent: manual({ op: "endGame" }),
    confirm: "End the game for everyone? This cannot be undone.",
  };
  const item =
    selection.length === 1 ? view.game.items.find((other) => other.id === selection[0]) : undefined;
  const zone = zones.find((candidate) => candidate.id === item?.zone);
  if (!item || !zone || !canTouch(zone, seat)) {
    const hint = "Select one item first";
    return [
      { id: "flip", label: "Flip", enabled: false, hint },
      { id: "rotate", label: "Rotate", enabled: false, hint },
      { id: "shuffle", label: "Shuffle", enabled: false, hint },
      endTurn,
      endGame,
    ];
  }
  const inZone = view.game.items.filter((other) => other.zone === zone.id).length;
  const buttons: ActionButton[] = [
    { id: "flip", label: "Flip", enabled: true, intent: manual({ op: "flip", item: item.id }) },
    {
      id: "rotate",
      label: "Rotate",
      enabled: true,
      intent: manual({ op: "rotate", item: item.id, deg: (item.rotation_deg + 90) % 360 }),
    },
  ];
  const def = components.defs.find((candidate) => candidate.id === item.def);
  if (def?.kind === "die") {
    buttons.push({
      id: "roll",
      label: "Roll",
      enabled: true,
      intent: manual({ op: "roll", item: item.id }),
    });
  }
  buttons.push(
    inZone > 1
      ? {
          id: "shuffle",
          label: `Shuffle ${zoneName(zone)}`,
          enabled: true,
          intent: manual({ op: "shuffle", zone: zone.id }),
        }
      : { id: "shuffle", label: "Shuffle", enabled: false, hint: "Nothing to shuffle" },
  );
  for (const each of components.zones ?? []) {
    if (each.owner !== "each") continue;
    const targets = view.ctx.seats.map((other) => `${each.id}:${other}`);
    if (targets.includes(zone.id)) continue;
    const enough = inZone >= targets.length;
    buttons.push({
      id: `deal:${each.id}`,
      label: `Deal 1 to each ${zoneName(each)}`,
      enabled: enough,
      ...(enough
        ? {
            // Only the owner sees an owner zone, so its cards arrive face up for the owner.
            intent: manual({
              op: "deal",
              from: zone.id,
              to: targets,
              count: 1,
              ...(each.visibility === "owner" ? { face: "up" as const } : {}),
            }),
          }
        : { hint: `Needs ${targets.length} items` }),
    });
  }
  buttons.push(endTurn, endGame);
  return buttons;
}

/** Built-in manual game. Declarations are validated and detached before use. */
export function createSandboxDefinition(
  input: ComponentsFile,
): GameDefinition<SandboxState, SandboxView> {
  const components = ComponentsFileSchema.parse(JSON.parse(JSON.stringify(input)));
  if (!components.zones || !components.setup) throw new Error("Sandbox needs zones and setup");
  const size = tableSize(components.zones);
  if (!size.every(Number.isSafeInteger)) throw new Error("Sandbox table is too large");
  return {
    sdk: 1,
    setup(init) {
      const zones = expandZones(components, init.seats);
      const state: SandboxState = { items: [] };
      const shuffles: string[] = [];
      for (const instance of components.setup?.instances ?? []) {
        const declaration = components.zones?.find((zone) => zone.id === instance.zone);
        const targets =
          declaration?.owner === "each"
            ? init.seats.map((seat) => `${instance.zone}:${seat}`)
            : [instance.zone];
        for (const target of targets) {
          const zone = zones.find((zone) => zone.id === target);
          const def = components.defs.find((def) => def.id === instance.def);
          if (!zone || !def || def.kind === "cardBack") throw new Error("Invalid setup instance");
          for (let index = 0; index < (instance.count ?? 1); index += 1) {
            const item: Item = {
              id: init.random.id(),
              def: instance.def,
              zone: target,
              index: ordered(state, target).length,
              rotation_deg: 0,
              face: instance.face ?? "up",
            };
            if (def.kind === "die") item.value = 1;
            if (zone.layout === "free")
              item.pos_mm = [Math.round(zone.rect_mm.x), Math.round(zone.rect_mm.y)];
            state.items.push(item);
          }
          if (instance.shuffle && !shuffles.includes(target)) shuffles.push(target);
        }
      }
      for (const zone of shuffles) shuffleZone(state, zone, init.random);
      canonicalOrder(state, zones);
      return state;
    },
    moves: {
      manual: {
        anySeat: true,
        parse(args, context) {
          const parsed = ManualOpSchema.safeParse(args);
          if (
            !parsed.success ||
            !context ||
            !validOperation(
              parsed.data,
              context.state,
              expandZones(components, context.ctx.seats),
              components,
              context.seat,
            )
          ) {
            return invalid("INVALID_ARGS", "Invalid manual operation");
          }
          return JsonSchema.parse(parsed.data);
        },
        apply(state, ctx, args) {
          const op = ManualOpSchema.parse(args);
          const zones = expandZones(components, ctx.seats);
          applyOperation(state, ctx, op, zones, components);
          canonicalOrder(state, zones);
        },
      },
    },
    playerView(state, ctx, seat) {
      const zones = expandZones(components, ctx.seats);
      return {
        items: zones.flatMap((zone) =>
          ordered(state, zone.id).map((item) => visibleItem(item, zone, components, seat)),
        ),
      };
    },
    interpret: (gesture, view, info) => interpretGesture(components, gesture, view, info),
    actions: (view, info, selection) => sandboxActions(components, view, info, selection),
    present(view, info): TableSnapshot {
      const zones = expandZones(components, view.ctx.seats);
      const canAct =
        info.seat !== null && view.ctx.seats.includes(info.seat) && view.result === null;
      return {
        table: { size_mm: tableSize(zones) },
        zones: zones.map((zone) => ({
          id: zone.id,
          layout: zone.layout,
          rect_mm: {
            x: Math.round(zone.rect_mm.x),
            y: Math.round(zone.rect_mm.y),
            w: Math.max(1, Math.round(zone.rect_mm.w)),
            h: Math.max(1, Math.round(zone.rect_mm.h)),
          },
          ...(zone.owner === undefined ? {} : { owner: zone.owner }),
          ...(zone.label === undefined ? {} : { label: zone.label }),
          ...(zone.grid === undefined ? {} : { grid: { ...zone.grid } }),
          droppable: canAct,
        })),
        items: view.game.items.map((item) => ({
          ...item,
          ...(item.pos_mm === undefined ? {} : { pos_mm: [...item.pos_mm] as [number, number] }),
          selectable:
            canAct &&
            zones.some(
              (zone) => zone.id === item.zone && info.seat !== null && canTouch(zone, info.seat),
            ),
          draggable:
            canAct &&
            zones.some(
              (zone) => zone.id === item.zone && info.seat !== null && canTouch(zone, info.seat),
            ),
        })),
        hud: view.ctx.seats.map((seat) => ({
          seat,
          active: seat === view.ctx.currentSeat,
          handCount: view.game.items.filter((item) =>
            zones.some(
              (zone) => zone.id === item.zone && zone.visibility === "owner" && zone.owner === seat,
            ),
          ).length,
        })),
      };
    },
  };
}
