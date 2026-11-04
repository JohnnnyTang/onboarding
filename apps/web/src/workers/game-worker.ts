// Entry point of the game worker (D-007). Created by src/match/game-worker-client.ts.
import { importGameModule } from "./game-module";
import { lockDownGlobals } from "./lockdown";
import type { WorkerInit } from "./protocol";
import { startWorker } from "./worker-main";

// The web app is typed with the DOM library; only these worker members are used here.
interface WorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<WorkerInit>) => void,
    options: { once: boolean },
  ): void;
}

const scope = globalThis as unknown as WorkerScope;
// Captured before the lockdown removes the global names.
const stopAt = [EventTarget.prototype, Object.prototype];

scope.addEventListener(
  "message",
  (event) => {
    const port = event.ports[0];
    if (!port || event.data?.t !== "init") return;
    void startWorker(event.data, port, {
      lockDown: () => lockDownGlobals(globalThis, stopAt),
      importGame: importGameModule,
    });
  },
  { once: true },
);
