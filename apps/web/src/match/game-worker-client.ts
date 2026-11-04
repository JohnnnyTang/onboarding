import {
  type AcceptedEvent,
  AcceptedEventSchema,
  type ActionButton,
  ActionButtonSchema,
  type ClientView,
  ClientViewSchema,
  type ComponentsFile,
  ErrorCodeSchema,
  type Gesture,
  type MatchInit,
  type MoveIntent,
  MoveIntentSchema,
  type SeatId,
  type TableSnapshot,
  TableSnapshotSchema,
} from "@bgp/schema";
import {
  type GameSource,
  INIT_REPLY_ID,
  type WorkerBooted,
  type WorkerCall,
  type WorkerInit,
  type WorkerReply,
  type WorkerRequest,
} from "../workers/protocol";

/** Time limit per call into game code (D-008), and for evaluating the bundle. */
export const GAME_CALL_TIMEOUT_MS = 1000;
export const GAME_LOAD_TIMEOUT_MS = 5000;
/** Time for the worker to fetch and start its own trusted code, before any game code. */
export const WORKER_BOOT_TIMEOUT_MS = 30_000;

export type GameWorkerFailure = "load" | "timeout" | "failed" | "invalid" | "stopped";

/** Game code failed. No details: they could contain game state. */
export class GameWorkerError extends Error {
  override readonly name = "GameWorkerError";
  constructor(readonly reason: GameWorkerFailure) {
    super(
      reason === "timeout"
        ? "The game stopped responding"
        : reason === "load"
          ? "The game could not be loaded"
          : "The game failed",
    );
  }
}

/** The parts of a Worker the client uses, so tests can supply a fake. */
export interface WorkerLike {
  postMessage(message: WorkerInit, transfer: Transferable[]): void;
  terminate(): void;
  onerror: ((event: ErrorEvent) => void) | null;
  /** Receives `WorkerBooted` once the worker script has started; nothing else. */
  onmessage: ((event: MessageEvent) => void) | null;
}

export type HotSeatOutcome =
  | { ok: true; event: AcceptedEvent }
  | { ok: false; code: string; gameCode?: string; message: string };

export interface GameWorker {
  present(view: ClientView, seat: SeatId | null): Promise<TableSnapshot>;
  interpret(gesture: Gesture, view: ClientView, seat: SeatId | null): Promise<MoveIntent | null>;
  actions(view: ClientView, seat: SeatId | null, selection: string[]): Promise<ActionButton[]>;
  hotSeat: {
    /** Starts a match, or resumes one by replaying its accepted events. */
    create(init: MatchInit, events?: readonly AcceptedEvent[]): Promise<void>;
    apply(seat: SeatId, intent: MoveIntent): Promise<HotSeatOutcome>;
    view(seat: SeatId | null): Promise<ClientView>;
  };
  /** True once the worker was stopped after a timeout, a crash or `destroy`. */
  readonly stopped: boolean;
  destroy(): void;
}

export interface GameWorkerOptions {
  createWorker?(): WorkerLike;
  timeoutMs?: number;
  loadTimeoutMs?: number;
  bootTimeoutMs?: number;
  setTimeout?(callback: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
}

function defaultWorker(): WorkerLike {
  return new Worker(new URL("../workers/game-worker.ts", import.meta.url), {
    type: "module",
    name: "bgp-game",
  });
}

const ActionsSchema = ActionButtonSchema.array();

function parseOutcome(value: unknown): HotSeatOutcome {
  if (typeof value === "object" && value !== null && "ok" in value) {
    const record = value as Record<string, unknown>;
    if (record.ok === true) {
      const event = AcceptedEventSchema.safeParse(record.event);
      if (event.success) return { ok: true, event: event.data };
    } else if (
      record.ok === false &&
      ErrorCodeSchema.safeParse(record.code).success &&
      typeof record.message === "string" &&
      (record.gameCode === undefined || typeof record.gameCode === "string")
    ) {
      return {
        ok: false,
        code: record.code as string,
        message: record.message,
        ...(record.gameCode === undefined ? {} : { gameCode: record.gameCode as string }),
      };
    }
  }
  throw new GameWorkerError("invalid");
}

/** A started worker that has not loaded a game yet. */
export interface BootedGameWorker {
  /** Evaluates the bundle (or starts the built-in sandbox) in the worker; call once. */
  load(game: GameSource, components: ComponentsFile): Promise<GameWorker>;
  destroy(): void;
}

/**
 * Starts a game worker for one bundle and talks to it over a private MessagePort. Each call
 * has a deadline; a call that misses it terminates the worker, and later calls fail. Every
 * reply is validated: game code is untrusted, so its output is too.
 */
export async function startGameWorker(
  options: GameWorkerOptions & { game: GameSource; components: ComponentsFile },
): Promise<GameWorker> {
  const booted = await bootGameWorker(options);
  return booted.load(options.game, options.components);
}

/**
 * Starts the worker and waits until its own code has loaded, without any game code. Booting
 * while the game files download saves time when a page opens.
 */
export async function bootGameWorker(options: GameWorkerOptions = {}): Promise<BootedGameWorker> {
  const worker = (options.createWorker ?? defaultWorker)();
  const schedule = options.setTimeout ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
  const cancel =
    options.clearTimeout ??
    ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>));
  const timeoutMs = options.timeoutMs ?? GAME_CALL_TIMEOUT_MS;
  const channel = new MessageChannel();
  const port = channel.port1;
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: GameWorkerError): void; timer: unknown }
  >();
  let nextId = INIT_REPLY_ID + 1;
  let stopped = false;

  function stop(reason: GameWorkerFailure) {
    if (stopped) return;
    stopped = true;
    worker.terminate();
    port.close();
    for (const call of pending.values()) {
      cancel(call.timer);
      call.reject(new GameWorkerError(reason));
    }
    pending.clear();
  }

  function expect(id: number, ms: number, onTimeout: GameWorkerFailure): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = schedule(() => {
        pending.delete(id);
        reject(new GameWorkerError(onTimeout));
        stop(onTimeout);
      }, ms);
      pending.set(id, { resolve, reject, timer });
    });
  }

  port.onmessage = (event: MessageEvent<unknown>) => {
    const reply = event.data as Partial<WorkerReply> | null;
    if (typeof reply !== "object" || reply === null || typeof reply.id !== "number") return;
    const call = pending.get(reply.id);
    if (!call) return;
    pending.delete(reply.id);
    cancel(call.timer);
    if (reply.ok === true) call.resolve((reply as { value: unknown }).value);
    else call.reject(new GameWorkerError(reply.id === INIT_REPLY_ID ? "load" : "failed"));
  };
  worker.onerror = () => stop("failed");

  // The worker first fetches its own code, which can be slow on a cold cache; only evaluating
  // the game counts against the load deadline.
  await new Promise<void>((resolve, reject) => {
    const timer = schedule(() => {
      stop("load");
      reject(new GameWorkerError("load"));
    }, options.bootTimeoutMs ?? WORKER_BOOT_TIMEOUT_MS);
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if ((event.data as Partial<WorkerBooted> | null)?.t !== "booted") return;
      worker.onmessage = null;
      cancel(timer);
      resolve();
    };
  });
  if (stopped) throw new GameWorkerError("load");

  let loading = false;
  async function load(source: GameSource, components: ComponentsFile): Promise<GameWorker> {
    if (stopped || loading) throw new GameWorkerError("stopped");
    loading = true;
    const loaded = expect(INIT_REPLY_ID, options.loadTimeoutMs ?? GAME_LOAD_TIMEOUT_MS, "load");
    worker.postMessage({ t: "init", game: source, components }, [channel.port2]);
    try {
      await loaded;
    } catch (error) {
      stop("load");
      throw error instanceof GameWorkerError ? error : new GameWorkerError("load");
    }
    return game;
  }

  async function call<T>(request: WorkerRequest, parse: (value: unknown) => T): Promise<T> {
    if (stopped) throw new GameWorkerError("stopped");
    const id = nextId;
    nextId += 1;
    const reply = expect(id, timeoutMs, "timeout");
    port.postMessage({ ...request, id } satisfies WorkerCall);
    const value = await reply;
    try {
      return parse(value);
    } catch {
      throw new GameWorkerError("invalid");
    }
  }

  const game: GameWorker = {
    present: (view, seat) =>
      call({ op: "present", view, seat }, (value) => TableSnapshotSchema.parse(value)),
    interpret: (gesture, view, seat) =>
      call({ op: "interpret", gesture, view, seat }, (value) =>
        MoveIntentSchema.nullable().parse(value),
      ),
    actions: (view, seat, selection) =>
      call({ op: "actions", view, seat, selection: [...selection] }, (value) =>
        ActionsSchema.parse(value),
      ),
    hotSeat: {
      create: (init, events = []) =>
        call({ op: "hotSeatCreate", init, events: [...events] }, () => undefined),
      apply: (seat, intent) => call({ op: "hotSeatApply", seat, intent }, parseOutcome),
      view: (seat) => call({ op: "hotSeatView", seat }, (value) => ClientViewSchema.parse(value)),
    },
    get stopped() {
      return stopped;
    },
    destroy: () => stop("stopped"),
  };
  return { load, destroy: () => stop("stopped") };
}
