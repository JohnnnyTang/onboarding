import { viewFor } from "@bgp/rules";
import {
  type ComponentsFile,
  ComponentsFileSchema,
  type GameDefinition,
  type Json,
  JsonSchema,
  type MatchState,
  MatchStateSchema,
  type SeatId,
  tableSnapshotForSeatSchema,
} from "@bgp/schema";
import { copy } from "./runner.js";

/** Trusted game-specific knowledge, derived independently of playerView/present. */
export interface LeakKnowledge {
  /** Secret identities/markers and retired IDs that must not occur anywhere in output. */
  forbiddenStrings: readonly string[];
  canIdentify(id: string): boolean;
  /** Verify provenance, not merely an ID-shaped regular expression. */
  isOpaqueId(id: string): boolean;
  isCard(id: string): boolean;
}

export type LeakOracle<S extends Json> = (state: MatchState<S>, seat: SeatId) => LeakKnowledge;

export interface LeakOptions<S extends Json> {
  components: ComponentsFile;
  oracle: LeakOracle<S>;
}

function inspect(value: Json, knowledge: LeakKnowledge): void {
  if (typeof value === "string") {
    if (knowledge.forbiddenStrings.some((secret) => value.includes(secret))) {
      throw new Error("forbidden identity or retired ID");
    }
  } else if (Array.isArray(value)) {
    for (const child of value) inspect(child, knowledge);
  } else if (value !== null && typeof value === "object") {
    // ClientView.game is arbitrary JSON. Recognize the contract's item-like objects
    // here as well as in present(), so a renderer cannot mask a leaked view.def.
    if (
      typeof value.id === "string" &&
      typeof value.zone === "string" &&
      !knowledge.canIdentify(value.id)
    ) {
      if (Object.hasOwn(value, "def") || Object.hasOwn(value, "value")) {
        throw new Error("hidden item exposes def or value");
      }
      if (!knowledge.isOpaqueId(value.id))
        throw new Error("hidden item ID has no opaque provenance");
    }
    for (const [key, child] of Object.entries(value)) {
      inspect(key, knowledge);
      inspect(child, knowledge);
    }
  }
}

/** Check every participating seat at one state; attach to runMatch.onStep for UNIT-LEAK. */
export function checkLeaks<S extends Json, V extends Json>(
  def: GameDefinition<S, V>,
  state: MatchState<S>,
  options: LeakOptions<S>,
): void {
  MatchStateSchema.parse(state);
  const components = ComponentsFileSchema.parse(options.components);
  for (const seat of state.ctx.seats) {
    const knowledge = options.oracle(copy(state), seat);
    if (knowledge.forbiddenStrings.some((secret) => secret.length === 0)) {
      throw new Error("Leak oracle must not supply empty forbidden strings");
    }
    let source = "ClientView";
    try {
      const view = viewFor(def, state, seat);
      inspect(JsonSchema.parse(view), knowledge);
      source = "TableSnapshot";
      const snapshot = def.present(copy(view), { seat, components: copy(components) });
      const validated = tableSnapshotForSeatSchema({
        components,
        canIdentify: (item) => knowledge.canIdentify(item.id),
        isCard: (item) => knowledge.isCard(item.id),
      }).safeParse(snapshot);
      if (!validated.success) throw new Error("invalid snapshot or hidden item def/back");
      for (const item of validated.data.items) {
        if (!knowledge.canIdentify(item.id) && !knowledge.isOpaqueId(item.id)) {
          throw new Error("hidden item ID has no opaque provenance");
        }
      }
      inspect(JsonSchema.parse(validated.data), knowledge);
    } catch {
      // Do not echo a game exception, secret value or malicious property name.
      throw new Error(`Leak check failed at seq ${state.ctx.moveNumber}, seat ${seat}, ${source}`);
    }
  }
}
