import {
  applyIntent,
  canonicalJson,
  createMatch,
  createSandboxDefinition,
  replay,
  viewFor,
} from "@bgp/rules";
import {
  AcceptedEventSchema,
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
 * SHA-256 from Web Crypto, captured by the worker before the lockdown removes `crypto`, so
 * game code cannot reach it. Absent outside a secure context.
 */
export type Digest = (bytes: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>;

/** `hashState` from @bgp/rules, with the digest passed in instead of read from a global. */
export async function hashWith(digest: Digest, state: MatchState): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(state));
  const hash = await digest(bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type SyncRequest = Exclude<WorkerRequest, { op: "replayHash" }>;

export interface WorkerHost {
  /** Answers every request except `replayHash`. */
  handle(request: SyncRequest): unknown;
  /** The hash of the replayed state after event `seq`. */
  hash(seq: number): Promise<string>;
}

/**
 * Answers worker requests for one game. Presentation calls see only the view they are given;
 * the hot-seat runtime keeps one local match, used when every seat plays on this device; a
 * replay keeps the state after every event of a finished match so the page can step through
 * it. Results go back to the page unvalidated: the page validates every reply.
 */
export function createWorkerHost(
  definition: GameDefinition<Json>,
  components: ComponentsFile,
  digest?: Digest,
): WorkerHost {
  let match: MatchState | null = null;
  // states[seq] is the state after event `seq`; states[0] is the setup.
  let states: MatchState[] = [];
  const local = (): MatchState => {
    if (!match) throw new Error("No hot-seat match");
    return match;
  };
  const replayed = (seq: number): MatchState => {
    const state = states[seq];
    if (!state) throw new Error("No replayed state at this step");
    return state;
  };
  const handle = (request: SyncRequest): unknown => {
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
      case "replayStart":
        states = [];
        states = [createMatch(definition, request.init)];
        return states.length - 1;
      case "replayAppend": {
        // Applied to a copy, so a rejected event leaves the replay as it was.
        const next = [...states];
        for (const input of request.events) {
          const previous = next.at(-1);
          const event = AcceptedEventSchema.parse(input);
          if (!previous || event.seq !== next.length) throw new Error("Invalid replay sequence");
          const result = applyIntent(definition, previous, event.seat, event.intent);
          if (!result.ok) throw new Error("Replay event rejected");
          next.push(result.state);
        }
        states = next;
        return states.length - 1;
      }
      case "replayView":
        return viewFor(definition, replayed(request.seq), request.seat);
    }
  };
  return {
    handle,
    async hash(seq) {
      if (!digest) throw new Error("No digest in this context");
      return hashWith(digest, replayed(seq));
    },
  };
}
