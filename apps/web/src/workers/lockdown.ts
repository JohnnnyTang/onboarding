/**
 * Global lockdown for the game worker (D-007). It runs before any game code is evaluated and
 * makes the worker match the rules host's QuickJS environment, so a game behaves the same in
 * both places:
 *
 * - Names that the rules host locks (packages/rules-host/src/bridge-source.ts) throw when read.
 * - Browser capabilities that QuickJS does not have at all read as `undefined`: storage,
 *   other network and messaging channels, nested workers and the worker's own messaging.
 *   The worker talks to the page only through a private MessagePort held in a closure.
 */

/** Same list as the rules host's LOCKDOWN_SOURCE. */
export const THROWING_GLOBALS = [
  "Date",
  "performance",
  "crypto",
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

/** Browser-only capabilities, absent in QuickJS, removed from the worker. */
export const REMOVED_GLOBALS = [
  // D-007 storage and network globals not covered above.
  "importScripts",
  "indexedDB",
  "caches",
  "BroadcastChannel",
  // Other ways out of the worker or into persistent storage.
  "navigator",
  "SharedWorker",
  "WebSocketStream",
  "WebTransport",
  "RTCPeerConnection",
  "RTCDataChannel",
  "fetchLater",
  "cookieStore",
  "Notification",
  "localStorage",
  "sessionStorage",
  "IDBFactory",
  "CacheStorage",
  "StorageManager",
  "FileSystemHandle",
  "FileSystemDirectoryHandle",
  "FileSystemFileHandle",
  "FileSystemSyncAccessHandle",
  // The worker's own channel to the page, and its lifetime.
  "postMessage",
  "onmessage",
  "onmessageerror",
  "addEventListener",
  "removeEventListener",
  "dispatchEvent",
  "close",
  "MessageChannel",
  // Remaining timer and scheduling functions.
  "clearTimeout",
  "clearInterval",
  "clearImmediate",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "scheduler",
] as const;

function blocked(): never {
  throw new Error("Not available to game code");
}

/**
 * Locks down `scope` (the worker's global object). Own properties of the global's prototypes
 * are deleted up to, but not including, any object in `stopAt` (EventTarget.prototype and
 * Object.prototype in a worker), so shared prototypes such as MessagePort's keep working.
 * Returns the names that could not be locked; the caller must not load the game if any are.
 */
export function lockDownGlobals(scope: object, stopAt: readonly object[]): string[] {
  const failures: string[] = [];
  const prototypes: object[] = [];
  for (
    let proto = Object.getPrototypeOf(scope) as object | null;
    proto !== null && !stopAt.includes(proto);
    proto = Object.getPrototypeOf(proto) as object | null
  ) {
    prototypes.push(proto);
  }
  const lock = (name: string, descriptor: PropertyDescriptor) => {
    for (const proto of prototypes) {
      if (Object.hasOwn(proto, name)) Reflect.deleteProperty(proto, name);
    }
    if (Object.hasOwn(scope, name)) Reflect.deleteProperty(scope, name);
    if (!Reflect.defineProperty(scope, name, { ...descriptor, configurable: false })) {
      failures.push(name);
    }
  };
  for (const name of THROWING_GLOBALS) lock(name, { get: blocked, enumerable: false });
  for (const name of REMOVED_GLOBALS) {
    lock(name, { value: undefined, writable: false, enumerable: false });
  }
  const math = (scope as { Math?: object }).Math;
  if (!math || !Reflect.defineProperty(math, "random", { get: blocked, configurable: false })) {
    failures.push("Math.random");
  }
  return [...failures, ...verifyLockdown(scope)];
}

/** Names that still resolve to something after the lockdown. */
export function verifyLockdown(scope: object): string[] {
  const failures: string[] = [];
  const record = scope as Record<string, unknown>;
  for (const name of THROWING_GLOBALS) {
    try {
      void record[name];
      failures.push(name);
    } catch {
      // Expected: reading the name throws.
    }
  }
  for (const name of REMOVED_GLOBALS) {
    if (record[name] !== undefined) failures.push(name);
  }
  try {
    void (record.Math as { random?: unknown } | undefined)?.random;
    failures.push("Math.random");
  } catch {
    // Expected.
  }
  return [...new Set(failures)];
}
