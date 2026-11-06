// Global lockdown for the validation worker. It mirrors the rules host (bridge-source.ts) and
// the game worker (apps/web/src/workers/lockdown.ts): the names they lock throw when read, so
// a game that would fail there fails here too. Unlike those, every trap records the name it
// guarded, so `bgp validate` can say which forbidden API the game reached for.

/** The rules host's LOCKDOWN_SOURCE list (crypto is handled separately below). */
export const TRAPPED_GLOBALS = [
  "Date",
  "performance",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "process",
  "require",
  "console",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "SharedArrayBuffer",
  "Atomics",
  "WebAssembly",
  "Worker",
  "WeakRef",
  "FinalizationRegistry",
  "constructor",
] as const;

/** Node globals that QuickJS does not have at all: they read as undefined, as there. */
export const REMOVED_GLOBALS = [
  "Buffer",
  "global",
  "navigator",
  "structuredClone",
  "BroadcastChannel",
  "MessageChannel",
  "MessagePort",
  "clearTimeout",
  "clearInterval",
  "clearImmediate",
] as const;

/** The game module is evaluated from a data URL, so its frames name this scheme. */
export const GAME_FRAME = "data:text/javascript";

export type Digest = (algorithm: "SHA-256", data: Uint8Array) => Promise<ArrayBuffer>;

/** Whether game code is on the current call stack. */
function calledFromGame(): boolean {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = Number.POSITIVE_INFINITY;
  try {
    return new Error().stack?.includes(GAME_FRAME) ?? false;
  } finally {
    Error.stackTraceLimit = limit;
  }
}

/**
 * Locks down `scope` and returns the set that collects trapped names as game code reads them.
 * The rules host also locks `crypto`, but `hashState` in the runtime needs its digest: game
 * code reading `crypto` is trapped, while the runtime gets a frozen object with only
 * `subtle.digest` (deterministic; `getRandomValues` and `randomUUID` are gone).
 */
export function lockDown(scope: typeof globalThis, digest: Digest): Set<string> {
  const touched = new Set<string>();
  const blocked = (name: string): never => {
    touched.add(name);
    throw new TypeError(`${name} is not available to game code`);
  };
  const define = (target: object, name: string, descriptor: PropertyDescriptor) => {
    Reflect.deleteProperty(target, name);
    if (!Reflect.defineProperty(target, name, { ...descriptor, configurable: false })) {
      throw new Error(`Could not lock ${name}`);
    }
  };
  for (const name of TRAPPED_GLOBALS) {
    define(scope, name, { get: () => blocked(name), enumerable: false });
  }
  for (const name of REMOVED_GLOBALS) {
    define(scope, name, { value: undefined, writable: false, enumerable: false });
  }
  define(scope.Math, "random", { get: () => blocked("Math.random"), enumerable: false });
  const subtle = Object.freeze({
    digest: (algorithm: "SHA-256", data: Uint8Array) => digest(algorithm, data),
  });
  const hashing = Object.freeze({ subtle });
  define(scope, "crypto", {
    get: () => (calledFromGame() ? blocked("crypto") : hashing),
    enumerable: false,
  });
  return touched;
}

/** Advice for each trapped name, shown when a game touched it. */
export function adviceFor(name: string): string {
  if (name === "Math.random") return "use ctx.random (or random in setup) instead";
  if (name === "Date" || name === "performance") return "game state may not depend on the clock";
  if (name === "console") return "the rules host has no console; remove logging before publishing";
  if (/Timeout|Interval|Immediate|queueMicrotask/.test(name)) {
    return "game code runs synchronously, without timers";
  }
  return "game code may not use platform APIs";
}
