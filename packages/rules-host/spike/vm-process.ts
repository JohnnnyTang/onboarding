import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  AcceptedEvent,
  ClientView,
  MatchInit,
  MatchState,
  MoveIntent,
  SeatId,
} from "@bgp/schema";
import { GameError } from "../src/errors.js";
import type { MoveOutcome, RulesSandbox, SandboxOptions } from "../src/sandbox.js";

interface Reply {
  ok: boolean;
  value?: unknown;
  elapsedMs?: number;
  heapBytes?: number;
  rssBytes?: number;
}

/** Disposable spike adapter, intentionally excluded from public exports. */
export class VmProcessSandbox implements RulesSandbox {
  private dead = false;
  private busy = false;
  elapsedMs = 0;
  heapBytes = 0;
  rssBytes = 0;
  private constructor(
    private readonly child: ChildProcess,
    private readonly timeoutMs: number,
  ) {}

  static async load(source: string, options: SandboxOptions = {}): Promise<VmProcessSandbox> {
    const dist = fileURLToPath(new URL("../dist/", import.meta.url));
    const child = fork(new URL("../dist/spike-vm-worker.js", import.meta.url), [], {
      execArgv: [
        "--permission",
        `--allow-fs-read=${dist}`,
        "--experimental-vm-modules",
        "--max-old-space-size=64",
      ],
      env: {},
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const sandbox = new VmProcessSandbox(child, options.timeoutMs ?? 1000);
    try {
      await sandbox.call({ source });
      return sandbox;
    } catch {
      sandbox.dispose();
      throw new GameError();
    }
  }

  private async call(message: object): Promise<unknown> {
    if (this.dead || this.busy) throw new GameError();
    this.busy = true;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.child.removeListener("message", response);
        this.child.removeListener("exit", failed);
        this.child.removeListener("error", failed);
        this.busy = false;
      };
      const failed = () => {
        cleanup();
        this.dispose();
        reject(new GameError());
      };
      const response = (raw: unknown) => {
        cleanup();
        if (typeof raw !== "object" || raw === null || !("ok" in raw) || raw.ok !== true) {
          this.dispose();
          reject(new GameError());
          return;
        }
        const reply = raw as Reply;
        this.elapsedMs = reply.elapsedMs ?? 0;
        this.heapBytes = reply.heapBytes ?? 0;
        this.rssBytes = reply.rssBytes ?? 0;
        resolve(reply.value);
      };
      const timer = setTimeout(failed, this.timeoutMs);
      this.child.once("message", response);
      this.child.once("exit", failed);
      this.child.once("error", failed);
      this.child.send(message, (error) => {
        if (error) failed();
      });
    });
  }

  async create(init: MatchInit): Promise<void> {
    await this.call({ request: { op: "create", init } });
  }
  async apply(seat: SeatId, intent: MoveIntent): Promise<MoveOutcome> {
    return (await this.call({ request: { op: "apply", seat, intent } })) as MoveOutcome;
  }
  async views(): Promise<Record<SeatId, ClientView>> {
    return (await this.call({ request: { op: "views" } })) as Record<SeatId, ClientView>;
  }
  async hash(): Promise<string> {
    const { createHash } = await import("node:crypto");
    const canonical = await this.call({ request: { op: "canonical" } });
    if (typeof canonical !== "string") throw new GameError();
    return createHash("sha256").update(canonical).digest("hex");
  }
  async exportState(): Promise<MatchState> {
    return (await this.call({ request: { op: "export" } })) as MatchState;
  }
  async restore(snapshot: MatchState, events: AcceptedEvent[]): Promise<void> {
    await this.call({ request: { op: "restore", snapshot, events } });
  }
  dispose(): void {
    if (!this.dead) {
      this.dead = true;
      this.child.kill();
    }
  }
}
