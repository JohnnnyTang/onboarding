import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  HOST_PROTOCOL_VERSION,
  type HostCommand,
  HostRequestSchema,
  HostResponseSchema,
} from "@bgp/schema";
import { GameError } from "./errors.js";
import { MAX_IPC_BYTES } from "./host-constants.js";
import type { SandboxOptions } from "./sandbox.js";

/** One process per match also contains native WASM crashes and allocator stalls. */
export class HostProcess {
  private dead = false;
  private nextId = 0;
  private pending:
    | {
        resolve(value: unknown): void;
        reject(error: GameError): void;
        id: number;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  private readonly child: ChildProcess;

  constructor(private readonly options: Required<SandboxOptions>) {
    const dist = fileURLToPath(new URL("../dist/", import.meta.url));
    this.child = fork(new URL("../dist/host-entry.js", import.meta.url), [], {
      execArgv: [
        "--permission",
        `--allow-fs-read=${dist}`,
        "--max-old-space-size=128",
        "--max-semi-space-size=1",
        "--optimize-for-size",
      ],
      env: {},
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
    });
    this.child.on("error", () => this.dispose());
    this.child.on("exit", () => this.dispose());
    this.child.on("disconnect", () => this.dispose());
    this.child.on("message", (raw: unknown) => this.receive(raw));
  }

  get alive(): boolean {
    return !this.dead;
  }
  get pid(): number | undefined {
    return this.child.pid;
  }

  private receive(raw: unknown): void {
    try {
      if (Buffer.byteLength(JSON.stringify(raw)) > MAX_IPC_BYTES) throw new GameError();
      const reply = HostResponseSchema.parse(raw);
      const pending = this.pending;
      if (!pending || pending.id !== reply.id || !reply.ok) throw new GameError();
      clearTimeout(pending.timer);
      this.pending = undefined;
      pending.resolve(reply.value);
    } catch {
      this.dispose();
    }
  }

  call(command: HostCommand, timeoutMs = this.options.timeoutMs): Promise<unknown> {
    if (this.dead || this.pending) return Promise.reject(new GameError());
    return new Promise((resolve, reject) => {
      try {
        const request = HostRequestSchema.parse({
          v: HOST_PROTOCOL_VERSION,
          id: ++this.nextId,
          command,
        });
        if (Buffer.byteLength(JSON.stringify(request)) > MAX_IPC_BYTES) throw new GameError();
        if (timeoutMs < 1) throw new GameError();
        const timer = setTimeout(() => this.dispose(), Math.min(timeoutMs, this.options.timeoutMs));
        this.pending = { resolve, reject, id: request.id, timer };
        this.child.send(request, (error) => {
          if (error) this.dispose();
        });
      } catch {
        this.dispose();
        reject(new GameError());
      }
    });
  }

  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new GameError());
    }
    this.child.kill("SIGKILL");
  }
}
