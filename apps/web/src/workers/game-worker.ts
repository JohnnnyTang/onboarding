// Entry point of the game worker (D-007). Created by src/match/game-worker-client.ts.
// First: Zod must not probe for `new Function` under the worker's policy (T20).
import "@bgp/schema/jitless";
import { importGameModule } from "./game-module";
import { lockDownGlobals } from "./lockdown";
import type { WorkerBooted, WorkerInit } from "./protocol";
import { startWorker } from "./worker-main";

// The web app is typed with the DOM library; only these worker members are used here.
interface WorkerScope {
  postMessage(message: WorkerBooted): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<WorkerInit>) => void,
    options: { once: boolean },
  ): void;
}

const scope = globalThis as unknown as WorkerScope;
// Captured before the lockdown removes the global names.
const stopAt = [EventTarget.prototype, Object.prototype];
// Web Crypto exists only in a secure context; without it replays skip the hash check.
const subtle = globalThis.crypto?.subtle;
const digest = subtle
  ? (bytes: Uint8Array<ArrayBuffer>) => subtle.digest("SHA-256", bytes)
  : undefined;

scope.addEventListener(
  "message",
  (event) => {
    const port = event.ports[0];
    if (!port || event.data?.t !== "init") return;
    void startWorker(event.data, port, {
      lockDown: () => lockDownGlobals(globalThis, stopAt),
      importGame: importGameModule,
      ...(digest ? { digest } : {}),
    });
  },
  { once: true },
);

// Tell the page this worker is ready for the bundle; the lockdown later removes postMessage.
scope.postMessage({ t: "booted" });
