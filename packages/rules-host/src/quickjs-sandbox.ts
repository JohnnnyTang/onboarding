import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  type AcceptedEvent,
  AcceptedEventSchema,
  ApplyResultSchema,
  type ClientView,
  ClientViewSchema,
  type ComponentsFile,
  ComponentsFileSchema,
  MAX_HOST_SOURCE_BYTES,
  type MatchInit,
  MatchInitSchema,
  type MatchState,
  MatchStateSchema,
  type MoveIntent,
  MoveIntentSchema,
  type SeatId,
  SeatIdSchema,
} from "@bgp/schema";
import type {
  QuickJSContext,
  QuickJSHandle,
  QuickJSRuntime,
  QuickJSWASMModule,
} from "quickjs-emscripten-core";
import { BRIDGE_SOURCE, LOCKDOWN_SOURCE } from "./bridge-source.js";
import { GameError } from "./errors.js";
import type { MoveOutcome, RulesSandbox, SandboxOptions } from "./sandbox.js";

let modulePromise: Promise<QuickJSWASMModule> | undefined;

// Only the server loads the locally installed release WASM; no CDN or browser path.
function quickjs(): Promise<QuickJSWASMModule> {
  modulePromise ??= Promise.all([
    import("quickjs-emscripten-core"),
    import("@jitl/quickjs-wasmfile-release-sync"),
  ]).then(([core, variant]) => {
    // Upstream's CJS-typed default differs from its Node ESM export condition.
    const release = variant.default as unknown as Extract<
      Parameters<typeof core.newVariant>[0],
      { type: "sync" }
    >;
    return readFile(new URL("../dist/quickjs.wasm", import.meta.url)).then((bytes) =>
      core.newQuickJSWASMModuleFromVariant(
        core.newVariant(release, {
          wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        }),
      ),
    );
  });
  return modulePromise;
}

/** Load only the trusted interpreter module; no game or match exists yet. */
export async function prepareQuickJs(): Promise<void> {
  await quickjs();
}

export class QuickJsSandbox implements RulesSandbox {
  private deadline = 0;
  private disposed = false;
  private dispatch: QuickJSHandle | undefined;
  private readonly timeoutMs: number;

  private constructor(
    private readonly runtime: QuickJSRuntime,
    private readonly context: QuickJSContext,
    options: SandboxOptions,
  ) {
    this.timeoutMs = options.timeoutMs ?? 1000;
    runtime.setMemoryLimit(options.memoryLimitBytes ?? 64 * 1024 * 1024);
    runtime.setMaxStackSize(512 * 1024);
    runtime.setInterruptHandler(() => performance.now() >= this.deadline);
    // No module imports, including dynamic imports, can reach the filesystem.
    runtime.setModuleLoader(() => {
      throw new GameError();
    });
  }

  /** Loads an enforced game: the bundle's default export is its `GameDefinition`. */
  static async load(gameSource: string, options: SandboxOptions = {}): Promise<QuickJsSandbox> {
    if (Buffer.byteLength(gameSource) > MAX_HOST_SOURCE_BYTES) throw new GameError();
    return QuickJsSandbox.start(options, (sandbox, factory) => {
      const exports = sandbox.eval(gameSource, "game.js", "module");
      try {
        const definition = sandbox.context.getProp(exports, "default");
        try {
          return sandbox.unwrap(
            sandbox.context.callFunction(factory, sandbox.context.undefined, definition),
          );
        } finally {
          definition.dispose();
        }
      } finally {
        exports.dispose();
      }
    });
  }

  /**
   * Loads a sandbox game (T17): the trusted runtime builds the built-in sandbox definition
   * from the components file. No game code is evaluated; the same lockdown and per-call
   * limits apply as for an enforced game.
   */
  static async loadSandbox(
    components: ComponentsFile,
    options: SandboxOptions = {},
  ): Promise<QuickJsSandbox> {
    const json = JSON.stringify(ComponentsFileSchema.parse(components));
    if (Buffer.byteLength(json) > MAX_HOST_SOURCE_BYTES) throw new GameError();
    return QuickJsSandbox.start(options, (sandbox, factory) => {
      const input = sandbox.context.newString(json);
      try {
        return sandbox.unwrap(
          sandbox.context.callFunction(
            factory,
            sandbox.context.undefined,
            sandbox.context.undefined,
            input,
          ),
        );
      } finally {
        input.dispose();
      }
    });
  }

  private static async start(
    options: SandboxOptions,
    define: (sandbox: QuickJsSandbox, factory: QuickJSHandle) => QuickJSHandle,
  ): Promise<QuickJsSandbox> {
    if (
      options.timeoutMs !== undefined &&
      (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1)
    )
      throw new GameError();
    if (
      options.memoryLimitBytes !== undefined &&
      (!Number.isSafeInteger(options.memoryLimitBytes) || options.memoryLimitBytes < 1)
    )
      throw new GameError();
    const engine = await quickjs();
    const runtime = engine.newRuntime();
    const sandbox = new QuickJsSandbox(runtime, runtime.newContext(), options);
    try {
      const runtimeSource = await readFile(
        new URL("../dist/runtime-bundle.js", import.meta.url),
        "utf8",
      );
      // Our runtime, bridge and lockdown are trusted; the parent bounds them with its recovery
      // watchdog (Q-019). The game module starts its own `timeoutMs` limit below.
      sandbox.deadline = Number.POSITIVE_INFINITY;
      sandbox.eval(runtimeSource).dispose();
      const factory = sandbox.eval(BRIDGE_SOURCE);
      try {
        sandbox.eval(LOCKDOWN_SOURCE).dispose();
        sandbox.deadline = performance.now() + sandbox.timeoutMs;
        sandbox.dispatch = define(sandbox, factory);
      } finally {
        factory.dispose();
      }
      return sandbox;
    } catch {
      sandbox.dispose();
      throw new GameError();
    }
  }

  private unwrap(result: ReturnType<QuickJSContext["evalCode"]>): QuickJSHandle {
    // Never dump exceptions: they can contain hidden state, huge graphs or getters.
    if (result.error) {
      result.error.dispose();
      throw new GameError();
    }
    return result.value;
  }

  private eval(source: string, filename = "runtime.js", type: "global" | "module" = "global") {
    const value = this.unwrap(this.context.evalCode(source, filename, { type }));
    if (this.runtime.hasPendingJob()) {
      value.dispose();
      throw new GameError();
    }
    return value;
  }

  private call(request: unknown): unknown {
    if (this.disposed || !this.dispatch) throw new GameError();
    this.deadline = performance.now() + this.timeoutMs;
    try {
      const input = this.context.newString(JSON.stringify(request));
      try {
        const output = this.unwrap(
          this.context.callFunction(this.dispatch, this.context.undefined, input),
        );
        try {
          if (this.runtime.hasPendingJob()) throw new GameError();
          if (this.context.typeof(output) !== "string") throw new GameError();
          return JSON.parse(this.context.getString(output));
        } finally {
          output.dispose();
        }
      } finally {
        input.dispose();
      }
    } catch {
      this.dispose();
      throw new GameError();
    }
  }

  async create(init: MatchInit): Promise<void> {
    this.checked(() => this.call({ op: "create", init: MatchInitSchema.parse(init) }));
  }

  async apply(seat: SeatId, intent: MoveIntent): Promise<MoveOutcome> {
    return this.checked(() => this.applyChecked(seat, intent));
  }

  private applyChecked(seat: SeatId, intent: MoveIntent): MoveOutcome {
    const result = this.call({
      op: "apply",
      seat: SeatIdSchema.parse(seat),
      intent: MoveIntentSchema.parse(intent),
    });
    // ApplyResult's success variant deliberately contains no authoritative state here.
    const event =
      typeof result === "object" && result !== null && "ok" in result && result.ok === true;
    if (event && "event" in result)
      return { ok: true, event: AcceptedEventSchema.parse(result.event) };
    const rejection = ApplyResultSchema.parse(result);
    if (rejection.ok) throw new GameError();
    if (rejection.code === "GAME_ERROR") {
      this.dispose();
      return { ok: false, code: "GAME_ERROR", message: "Game execution failed" };
    }
    return {
      ok: false,
      code: rejection.code,
      message: rejection.message,
      ...(rejection.gameCode === undefined ? {} : { gameCode: rejection.gameCode }),
    };
  }

  async views(): Promise<Record<SeatId, ClientView>> {
    return this.checked(() => this.viewsChecked());
  }

  private viewsChecked(): Record<SeatId, ClientView> {
    const value = this.call({ op: "views" });
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new GameError();
    const result: Record<SeatId, ClientView> = {};
    for (const [seat, view] of Object.entries(value))
      result[SeatIdSchema.parse(seat)] = ClientViewSchema.parse(view);
    return result;
  }

  async hash(): Promise<string> {
    return this.checked(() => this.hashChecked());
  }

  private hashChecked(): string {
    const canonical = this.call({ op: "canonical" });
    if (typeof canonical !== "string") throw new GameError();
    return createHash("sha256").update(canonical).digest("hex");
  }

  async exportState(): Promise<MatchState> {
    return this.checked(() => MatchStateSchema.parse(this.call({ op: "export" })));
  }

  async restore(snapshot: MatchState, events: AcceptedEvent[]): Promise<void> {
    this.checked(() =>
      this.call({
        op: "restore",
        snapshot: MatchStateSchema.parse(snapshot),
        events: events.map((event) => AcceptedEventSchema.parse(event)),
      }),
    );
  }

  private checked<T>(run: () => T): T {
    try {
      return run();
    } catch {
      this.dispose();
      throw new GameError();
    }
  }

  /** Interpreter heap statistics for the spike; not an IPC/client API. */
  memoryUsage(): unknown {
    if (this.disposed) throw new GameError();
    const handle = this.runtime.computeMemoryUsage();
    try {
      return this.context.dump(handle);
    } finally {
      handle.dispose();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dispatch?.dispose();
    this.context.dispose();
    this.runtime.dispose();
  }
}
