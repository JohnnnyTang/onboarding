import { applyIntent, createMatch, viewFor } from "@bgp/rules";
import {
  type ComponentsFile,
  type GameDefinition,
  GameDefinitionSchema,
  type Json,
  type MatchState,
} from "@bgp/schema";
import type { WorkerRequest } from "./protocol";

/** Checks the shape of a bundle's default export before any of it is called. */
export function asGameDefinition(value: unknown): GameDefinition<Json> | null {
  return GameDefinitionSchema.safeParse(value).success ? (value as GameDefinition<Json>) : null;
}

/**
 * Answers worker requests for one game. Presentation calls see only the view they are given;
 * the hot-seat runtime keeps one local match, used when every seat plays on this device.
 * Results go back to the page unvalidated: the page validates every reply.
 */
export function createWorkerHost(
  definition: GameDefinition<Json>,
  components: ComponentsFile,
): (request: WorkerRequest) => unknown {
  let match: MatchState | null = null;
  const local = (): MatchState => {
    if (!match) throw new Error("No hot-seat match");
    return match;
  };
  return (request) => {
    switch (request.op) {
      case "present":
        return definition.present(request.view, { seat: request.seat, components });
      case "interpret":
        return (
          definition.interpret?.(request.gesture, request.view, {
            seat: request.seat,
            components,
          }) ?? null
        );
      case "actions":
        return (
          definition.actions?.(request.view, { seat: request.seat, components }, [
            ...request.selection,
          ]) ?? []
        );
      case "hotSeatCreate":
        match = createMatch(definition, request.init);
        return null;
      case "hotSeatApply": {
        const result = applyIntent(definition, local(), request.seat, request.intent);
        if (!result.ok) return result;
        match = result.state;
        return { ok: true, event: result.event };
      }
      case "hotSeatView":
        return viewFor(definition, local(), request.seat);
    }
  };
}
