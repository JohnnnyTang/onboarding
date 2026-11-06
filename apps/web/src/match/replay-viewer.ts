import type { ClientView, ReplayResponse, SeatId, TableSnapshot } from "@bgp/schema";
import { type GameWorker, GameWorkerError } from "./game-worker-client";
import { mergeSnapshots } from "./merge-snapshots";

/** A seat's perspective, or every seat's knowledge at once (read-only, Q-021). */
export type ReplayViewing = SeatId | "all";

/** The replayed final state compared with the hash the server stored. */
export type HashCheck =
  | { status: "pending" }
  | { status: "match"; hash: string }
  | { status: "mismatch"; hash: string; expected: string }
  /** The worker could not hash here (no Web Crypto outside a secure context). */
  | { status: "unavailable" };

export interface ReplayState {
  status: "loading" | "ready" | "failed";
  /** Events rebuilt so far; equals `total` once ready. */
  loaded: number;
  total: number;
  /** The step asked for: 0 is the setup, `n` the state after event `n`. */
  seq: number;
  /** The step the current snapshot shows; lags `seq` while it is being drawn. */
  shownSeq: number | null;
  viewing: ReplayViewing;
  view: ClientView | null;
  snapshot: TableSnapshot | null;
  hashCheck: HashCheck;
  error: GameWorkerError | null;
}

export interface ReplayController {
  getState(): ReplayState;
  subscribe(listener: () => void): () => void;
  /** Rebuilds the match in the worker, checks the final hash, then shows the setup. */
  load(): Promise<void>;
  goTo(seq: number): void;
  step(delta: number): void;
  setViewing(viewing: ReplayViewing): void;
  destroy(): void;
}

/** Events per worker call while rebuilding; each call has its own deadline. */
export const REPLAY_CHUNK = 50;

type ReplayWorker = Pick<GameWorker, "present" | "replay" | "stopped">;

/**
 * Steps through a finished match rebuilt in the game worker. The worker keeps every state;
 * this asks for one seat's view of a step (or every seat's, merged) and presents it. When
 * steps are requested faster than they are drawn, only the latest one is drawn next.
 */
export function createReplayViewer(worker: ReplayWorker, replay: ReplayResponse): ReplayController {
  const total = replay.events.length;
  const seats = replay.seats;
  let state: ReplayState = {
    status: "loading",
    loaded: 0,
    total,
    seq: 0,
    shownSeq: null,
    viewing: seats[0] ?? "all",
    view: null,
    snapshot: null,
    hashCheck: { status: "pending" },
    error: null,
  };
  const listeners = new Set<() => void>();
  let destroyed = false;
  let drawing = false;
  let dirty = false;

  function update(patch: Partial<ReplayState>) {
    if (destroyed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }

  function fail(error: unknown) {
    update({
      status: "failed",
      error: error instanceof GameWorkerError ? error : new GameWorkerError("failed"),
    });
  }

  async function frame(
    seq: number,
    viewing: ReplayViewing,
  ): Promise<{ view: ClientView | null; snapshot: TableSnapshot | null }> {
    if (viewing !== "all") {
      const view = await worker.replay.view(seq, viewing);
      return { view, snapshot: await worker.present(view, viewing) };
    }
    const views = await Promise.all(seats.map((seat) => worker.replay.view(seq, seat)));
    const snapshots = await Promise.all(
      views.map((view, index) => worker.present(view, seats[index] ?? null)),
    );
    return { view: views[0] ?? null, snapshot: mergeSnapshots(snapshots) };
  }

  /** Draws the requested step; requests made meanwhile collapse into one more draw. */
  async function draw() {
    if (drawing) {
      dirty = true;
      return;
    }
    drawing = true;
    try {
      do {
        dirty = false;
        const { seq, viewing } = state;
        const next = await frame(seq, viewing);
        if (destroyed || state.status !== "ready") return;
        // A seat switch makes a snapshot from the old seat wrong; a step change does not.
        if (viewing === state.viewing) update({ ...next, shownSeq: seq });
      } while (dirty);
    } catch (error) {
      fail(error);
    } finally {
      drawing = false;
    }
  }

  function goTo(seq: number) {
    const target = Math.min(total, Math.max(0, Math.trunc(seq)));
    if (target === state.seq) return;
    update({ seq: target });
    if (state.status === "ready") void draw();
  }

  async function checkHash(): Promise<HashCheck> {
    try {
      const hash = await worker.replay.hash(total);
      return hash === replay.finalHash
        ? { status: "match", hash }
        : { status: "mismatch", hash, expected: replay.finalHash };
    } catch (error) {
      // Only a worker that is still running lacks a digest; anything else is a failure.
      if (worker.stopped) throw error;
      return { status: "unavailable" };
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async load() {
      try {
        await worker.replay.start({ seats, seed: replay.seed, options: replay.options });
        for (let start = 0; start < total; start += REPLAY_CHUNK) {
          const loaded = await worker.replay.append(
            replay.events.slice(start, start + REPLAY_CHUNK),
          );
          update({ loaded });
        }
        const hashCheck = await checkHash();
        update({ status: "ready", loaded: total, hashCheck });
      } catch (error) {
        fail(error);
        return;
      }
      await draw();
    },
    goTo,
    step: (delta) => goTo(state.seq + delta),
    setViewing(viewing) {
      if (viewing === state.viewing) return;
      update({ viewing, snapshot: null, view: null, shownSeq: null });
      if (state.status === "ready") void draw();
    },
    destroy() {
      destroyed = true;
      listeners.clear();
    },
  };
}
