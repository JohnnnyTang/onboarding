import { applyIntent, createSandboxDefinition, replay, viewFor } from "@bgp/rules";
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

/** The built-in manual game for a sandbox components file; throws on invalid declarations. */
export function sandboxDefinition(components: ComponentsFile): GameDefinition<Json> {
  // SandboxState and SandboxView are JSON; the definition only ever receives its own values.
  return createSandboxDefinition(components) as unknown as GameDefinition<Json>;
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
        match = null;
        match = replay(definition, request.init, request.events);
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
