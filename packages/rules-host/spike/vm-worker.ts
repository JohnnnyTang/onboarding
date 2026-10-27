import { readFile } from "node:fs/promises";
import { createContext, runInContext, SourceTextModule } from "node:vm";
import { BRIDGE_SOURCE, LOCKDOWN_SOURCE } from "../src/bridge-source.js";

// Comparison only: a dedicated restricted process owns this VM. No Node object or
// callable is injected into its context. The parent kills it at the call deadline.
const context = createContext(Object.create(null), {
  codeGeneration: { strings: false, wasm: false },
  microtaskMode: "afterEvaluate",
});
let dispatch: ((raw: string) => string) | undefined;
let importAttempted = false;
process.on("message", async (message: { source?: string; request?: unknown }) => {
  try {
    const started = performance.now();
    if (message.source !== undefined) {
      const runtime = await readFile(new URL("./runtime-bundle.js", import.meta.url), "utf8");
      runInContext(runtime, context);
      const factory = runInContext(BRIDGE_SOURCE, context) as (
        def: unknown,
      ) => (raw: string) => string;
      runInContext(LOCKDOWN_SOURCE, context);
      const game = new SourceTextModule(message.source, {
        context,
        importModuleDynamically() {
          importAttempted = true;
          throw Error();
        },
      });
      await game.link(() => {
        throw Error();
      });
      await game.evaluate();
      const namespace = game.namespace as { default?: unknown };
      dispatch = factory(namespace.default);
      process.send?.({ ok: true, value: null, elapsedMs: performance.now() - started });
    } else {
      if (!dispatch) throw Error();
      const value: unknown = JSON.parse(dispatch(JSON.stringify(message.request)));
      if (importAttempted) throw Error();
      process.send?.({
        ok: true,
        value,
        elapsedMs: performance.now() - started,
        heapBytes: process.memoryUsage().heapUsed,
      });
    }
  } catch {
    process.send?.({ ok: false });
  }
});
