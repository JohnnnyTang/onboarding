import { canonicalJson } from "@bgp/rules";
import {
  type ClientView,
  type ComponentsFile,
  type ItemPlacement,
  type Json,
  type SeatId,
  SeatIdSchema,
  type TableSnapshot,
  tableSnapshotForSeatSchema,
} from "@bgp/schema";

// Generic hidden-information checks for `bgp validate`. The T05 leak checker needs an oracle
// written for the game; the CLI has none, so it uses what every game shows: each seat's
// table. A seat "sees" an instance (by its ID) or a definition when its table shows it face
// up, and the checker remembers what each seat has seen during the game.
//
// 1. Each table is a valid TableSnapshot: hidden items carry no `def` or die value.
// 2. Items in another seat's declared owner zone (`visibility: "owner"`) are hidden.
// 3. A seat's view may not carry something the seat has never seen when another seat sees it
//    now (another hand), or when no seat has ever seen it (the deck). "Carry" means an
//    object with an instance's ID and all of that instance's fields from the full state, or
//    the ID of a card (or two-sided token) definition as a string.
//
// Rule 3 catches a playerView that forgets to redact, while accepting public history a table
// does not draw (a discard pile under its top card). It does not prove the absence of leaks:
// a partly redacted instance, or identities encoded some other way, pass. Games keep their own
// leak tests with an oracle (testing.md, reusable leak checks).

export interface SeatOutput {
  seat: SeatId | null;
  view: ClientView;
  /** What `present` returned for this view; validated here. */
  snapshot: unknown;
}

export interface LeakProblem {
  seat: SeatId | null;
  message: string;
}

/** What each seat has seen face up so far in one game; create one per game. */
export class SeenMemory {
  readonly #seen = new Map<SeatId | null, Set<string>>();
  readonly #any = new Set<string>();
  seenBy(seat: SeatId | null): Set<string> {
    let seen = this.#seen.get(seat);
    if (!seen) {
      seen = new Set();
      this.#seen.set(seat, seen);
    }
    return seen;
  }
  seenByAnyone(key: string): boolean {
    return this.#any.has(key);
  }
  record(seat: SeatId | null, keys: Iterable<string>): void {
    const seen = this.seenBy(seat);
    for (const key of keys) {
      seen.add(key);
      this.#any.add(key);
    }
  }
}

function seatName(seat: SeatId | null): string {
  return seat === null ? "The spectator" : `Seat ${seat}`;
}

/** Definitions whose identity can be hidden: cards, and tokens with a back. */
export function hideableDefs(components: ComponentsFile): Set<string> {
  return new Set(
    components.defs
      .filter((def) => def.kind === "card" || (def.kind === "token" && def.back !== undefined))
      .map((def) => def.id),
  );
}

/** The seat that owns a snapshot zone through a declared owner zone, if any. */
function ownerOf(components: ComponentsFile, zoneId: string): SeatId | null {
  for (const zone of components.zones ?? []) {
    if (zone.visibility !== "owner" || zone.owner === undefined) continue;
    if (zone.owner !== "each") {
      if (zone.id === zoneId) return zone.owner;
      continue;
    }
    const prefix = `${zone.id}:`;
    const suffix = zoneId.slice(prefix.length);
    if (zoneId.startsWith(prefix) && SeatIdSchema.safeParse(suffix).success) return suffix;
  }
  return null;
}

function objects(value: Json, visit: (object: { [key: string]: Json }) => void): void {
  if (Array.isArray(value)) for (const child of value) objects(child, visit);
  else if (value !== null && typeof value === "object") {
    visit(value);
    for (const child of Object.values(value)) objects(child, visit);
  }
}

function strings(value: Json, visit: (text: string) => void): void {
  if (typeof value === "string") visit(value);
  else if (Array.isArray(value)) for (const child of value) strings(child, visit);
  else if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) strings(child, visit);
  }
}

/**
 * Instances in the full state, keyed by ID, with each field's canonical JSON: objects with a
 * string `id` and other fields, and entries of ID-keyed records (`cards: { [id]: {...} }`)
 * whose values hold only plain values, so containers such as `cards` itself do not count.
 * Seat-numbered IDs are players, not instances. Only these IDs count, so a view's own
 * objects cannot be mistaken for instances.
 */
function isFlatObject(value: Json): value is { [key: string]: Json } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((field) => field === null || typeof field !== "object")
  );
}

export function stateInstances(game: Json): Map<string, Map<string, string>> {
  const instances = new Map<string, Map<string, string>>();
  const add = (id: string, fields: { [key: string]: Json }) => {
    if (SeatIdSchema.safeParse(id).success || Object.keys(fields).length === 0) return;
    instances.set(
      id,
      new Map(Object.entries(fields).map(([key, field]) => [key, canonicalJson(field)])),
    );
  };
  objects(game, (object) => {
    const { id, ...fields } = object;
    if (typeof id === "string") add(id, fields);
    for (const [key, entry] of Object.entries(object)) {
      if (isFlatObject(entry)) add(key, entry);
    }
  });
  return instances;
}

/** Whether `object` carries every field of the instance with the same value. */
function carriesInstance(object: { [key: string]: Json }, fields: Map<string, string>): boolean {
  for (const [key, value] of fields) {
    const field = object[key];
    if (field === undefined || canonicalJson(field) !== value) return false;
  }
  return true;
}

/** Validates one table; returns it, or the problems that make it invalid for the seat. */
function parseTable(
  components: ComponentsFile,
  output: SeatOutput,
): { snapshot: TableSnapshot } | { problems: LeakProblem[] } {
  const { seat } = output;
  const ownerHidden = (item: ItemPlacement) => {
    const owner = ownerOf(components, item.zone);
    return owner !== null && owner !== seat;
  };
  const parsed = tableSnapshotForSeatSchema({
    components,
    canIdentify: (item) => !ownerHidden(item),
  }).safeParse(output.snapshot);
  if (parsed.success) return { snapshot: parsed.data };
  return {
    problems: parsed.error.issues.map((issue) => {
      const at = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
      const message =
        issue.message === "Hidden items must omit def"
          ? `${seatName(seat)}'s table shows an item in another seat's owner zone face up${at}`
          : `${seatName(seat)}'s table is not a valid TableSnapshot${at}: ${issue.message}`;
      return { seat, message };
    }),
  };
}

/** What a table shows face up: item IDs and definition IDs. */
function faceUp(snapshot: TableSnapshot): Set<string> {
  const shown = new Set<string>();
  for (const item of snapshot.items) {
    if (item.def === undefined) continue;
    shown.add(`item:${item.id}`);
    shown.add(`def:${item.def}`);
  }
  return shown;
}

/**
 * Checks every seat's output at one step of a game. `outputs` holds each participating seat
 * and the spectator (`null`); `game` is the full state the views were made from.
 */
export function checkStep(
  components: ComponentsFile,
  game: Json,
  outputs: readonly SeatOutput[],
  memory: SeenMemory,
): LeakProblem[] {
  const tables = new Map<SeatId | null, Set<string>>();
  const problems: LeakProblem[] = [];
  for (const output of outputs) {
    const parsed = parseTable(components, output);
    if ("problems" in parsed) problems.push(...parsed.problems);
    else tables.set(output.seat, faceUp(parsed.snapshot));
  }
  if (problems.length > 0) return problems;
  for (const [seat, shown] of tables) memory.record(seat, shown);

  /** Rule 3: whether `seat` may not hold `key` in its view. */
  const hidden = (seat: SeatId | null, key: string) => {
    if (memory.seenBy(seat).has(key)) return false;
    if (!memory.seenByAnyone(key)) return true;
    for (const [other, shown] of tables) {
      if (other !== null && other !== seat && shown.has(key)) return true;
    }
    return false;
  };
  const instances = stateInstances(game);
  const hideable = hideableDefs(components);
  for (const { seat, view } of outputs) {
    const leakedIds = new Set<string>();
    const leakedDefs = new Set<string>();
    objects(view.game, (object) => {
      const id = object.id;
      if (typeof id !== "string") return;
      const fields = instances.get(id);
      if (fields && carriesInstance(object, fields) && hidden(seat, `item:${id}`)) {
        leakedIds.add(id);
      }
    });
    strings(view.game, (text) => {
      if (hideable.has(text) && hidden(seat, `def:${text}`)) leakedDefs.add(text);
    });
    const who = seatName(seat);
    for (const id of [...leakedIds].sort()) {
      problems.push({
        seat,
        message: `${who}'s view carries instance "${id}" with all its data, but this seat's table has never shown it face up; playerView must remove what this seat may not know`,
      });
    }
    for (const def of [...leakedDefs].sort()) {
      problems.push({
        seat,
        message: `${who}'s view names "${def}", which this seat's table has never shown face up; playerView must remove what this seat may not know`,
      });
    }
  }
  return problems;
}
