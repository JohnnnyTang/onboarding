import { INIT_REPLY_ID, type WorkerCall, type WorkerInit, type WorkerReply } from "./protocol";
import {
  asGameDefinition,
  createWorkerHost,
  type Digest,
  sandboxDefinition,
  type WorkerHost,
} from "./worker-host";

/** The parts of a MessagePort the worker uses. */
export interface WorkerPort {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: WorkerReply): void;
}

export interface WorkerDeps {
  /** Locks the worker's globals; returns the names that could not be locked. */
  lockDown(): string[];
  importGame(source: string): Promise<unknown>;
  /** SHA-256 for replay hash checks, captured before the lockdown. */
  digest?: Digest;
}

/**
 * Starts the game worker on its private port: lock down the globals, evaluate the bundle,
 * then answer requests. Any failure replies `ok: false` without details, because game errors
 * can carry hidden state. The worker never loads the game if the lockdown is incomplete.
 */
export async function startWorker(init: WorkerInit, port: WorkerPort, deps: WorkerDeps) {
  const reply = (message: WorkerReply) => {
    try {
      port.postMessage(message);
    } catch {
      // The value could not be cloned (functions, proxies, ...): report a plain failure.
      port.postMessage({ id: message.id, ok: false });
    }
  };
  let handle: WorkerHost | undefined;
  try {
    // Sandbox games run trusted platform code, but the worker is locked the same way, so
    // both kinds behave alike.
    if (deps.lockDown().length > 0) throw new Error("Lockdown incomplete");
    const definition =
      init.game.kind === "sandbox"
        ? sandboxDefinition(init.components)
        : asGameDefinition(await deps.importGame(init.game.source));
    if (!definition) throw new Error("Not a game definition");
    handle = createWorkerHost(definition, init.components, deps.digest);
  } catch {
    reply({ id: INIT_REPLY_ID, ok: false });
    return;
  }
  const host = handle;
  port.onmessage = (event) => {
    const call = event.data as WorkerCall;
    if (call.op === "replayHash") {
      // Trusted platform code only: hashing never awaits anything game code returned.
      host.hash(call.seq).then(
        (value) => reply({ id: call.id, ok: true, value }),
        () => reply({ id: call.id, ok: false }),
      );
      return;
    }
    let value: unknown;
    try {
      value = host.handle(call);
    } catch {
      reply({ id: call.id, ok: false });
      return;
    }
    reply({ id: call.id, ok: true, value });
  };
  reply({ id: INIT_REPLY_ID, ok: true, value: null });
}
