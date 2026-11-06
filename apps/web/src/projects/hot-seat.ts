import type {
  ActionButton,
  ClientView,
  Gesture,
  HotSeatMatchRecord,
  Json,
  MoveIntent,
  SeatId,
  TableSnapshot,
} from "@bgp/schema";
import { type GameWorker, GameWorkerError } from "../match/game-worker-client";
import { mergeSnapshots } from "../match/merge-snapshots";
import { createTablePresenter, type TablePresenter } from "../match/table-presenter";

/** A seat, or every seat's knowledge at once (the designer's debug view, read-only). */
export type Viewing = SeatId | "all";

export interface HotSeatState {
  status: "starting" | "ready" | "failed";
  match: HotSeatMatchRecord | null;
  viewing: Viewing;
  view: ClientView | null;
  snapshot: TableSnapshot | null;
  actions: readonly ActionButton[];
  selection: readonly string[];
  /** The game's message for the last rejected move. */
  rejection: string | null;
  /** A move is being applied; further moves wait. */
  pending: boolean;
  /** Something the designer should know, such as a save that failed. */
  notice: string | null;
  error: GameWorkerError | null;
}

export interface HotSeatDeps {
  worker: GameWorker;
  /** Writes the match after every accepted event. */
  persist(match: HotSeatMatchRecord): Promise<void>;
  newId(): string;
  newSeed(): number;
  now(): string;
  /** Options for new games: the manifest's defaults. Sandbox projects have none. */
  options?: Json;
}

export interface HotSeatController {
  getState(): HotSeatState;
  subscribe(listener: () => void): () => void;
  /** Resumes a stored match, or starts a new one with `seatCount` seats. */
  start(stored: HotSeatMatchRecord | null, projectId: string, seatCount: number): Promise<void>;
  newGame(seatCount: number): Promise<void>;
  setViewing(viewing: Viewing): void;
  setSelection(ids: readonly string[]): void;
  gesture(gesture: Gesture): void;
  act(intent: MoveIntent | undefined): void;
  dismissRejection(): void;
  destroy(): void;
}

/** A uint32 match seed from the browser's CSPRNG (page code; never game code). */
export function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
}

export function seatsFor(count: number): SeatId[] {
  return Array.from({ length: count }, (_, seat) => String(seat));
}

const INITIAL: HotSeatState = {
  status: "starting",
  match: null,
  viewing: "0",
  view: null,
  snapshot: null,
  actions: [],
  selection: [],
  rejection: null,
  pending: false,
  notice: null,
  error: null,
};

/**
 * Runs a hot-seat match in the game worker: every seat plays on this device, one at a time.
 * The worker holds the match; this keeps the stored record (init + events) in step, and
 * presents the table for the seat being viewed.
 */
export function createHotSeat(deps: HotSeatDeps): HotSeatController {
  const { worker } = deps;
  let state: HotSeatState = INITIAL;
  const listeners = new Set<() => void>();
  let presenter: TablePresenter | null = null;
  let unsubscribe: (() => void) | null = null;
  let revision = 0;
  let destroyed = false;
  let projectId = "";

  function update(patch: Partial<HotSeatState>) {
    if (destroyed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }

  function fail(error: unknown) {
    update({
      status: "failed",
      pending: false,
      error: error instanceof GameWorkerError ? error : new GameWorkerError("failed"),
    });
  }

  function showSeat(seat: SeatId | null) {
    unsubscribe?.();
    unsubscribe = null;
    presenter = seat === null ? null : createTablePresenter(worker, seat);
    if (!presenter) return;
    const current = presenter;
    unsubscribe = current.subscribe(() => {
      if (presenter !== current) return;
      const table = current.getState();
      update({
        snapshot: table.snapshot,
        actions: table.actions,
        selection: table.selection,
        ...(table.error ? { error: table.error, status: "failed" } : {}),
      });
    });
  }

  /** Shows the current match from the viewed seat (or all seats). */
  async function refresh() {
    const match = state.match;
    if (!match) return;
    const mine = ++revision;
    const viewing = state.viewing;
    if (viewing === "all") {
      const seats = match.init.seats;
      const views = await Promise.all(seats.map((seat) => worker.hotSeat.view(seat)));
      const snapshots = await Promise.all(
        views.map((view, index) => worker.present(view, seats[index] ?? null)),
      );
      if (mine !== revision) return;
      update({
        view: views[0] ?? null,
        snapshot: mergeSnapshots(snapshots),
        actions: [],
        selection: [],
      });
      return;
    }
    const view = await worker.hotSeat.view(viewing);
    if (mine !== revision) return;
    update({ view });
    presenter?.setView(view);
  }

  async function begin(match: HotSeatMatchRecord) {
    await worker.hotSeat.create(match.init, match.events);
    const viewing =
      state.viewing === "all" || match.init.seats.includes(state.viewing) ? state.viewing : "0";
    update({ match, viewing, status: "ready", rejection: null, error: null });
    showSeat(viewing === "all" ? null : viewing);
    await refresh();
  }

  async function newGame(seatCount: number) {
    const match: HotSeatMatchRecord = {
      id: deps.newId(),
      projectId,
      init: { seats: seatsFor(seatCount), seed: deps.newSeed(), options: deps.options ?? {} },
      events: [],
      updatedAt: deps.now(),
    };
    await begin(match);
    await save(match);
  }

  async function save(match: HotSeatMatchRecord) {
    try {
      await deps.persist(match);
    } catch {
      update({ notice: "This game could not be saved on this device; it continues unsaved." });
    }
  }

  async function apply(intent: MoveIntent) {
    const match = state.match;
    const seat = state.viewing;
    if (!match || seat === "all" || state.pending || state.status !== "ready") return;
    update({ pending: true, rejection: null });
    try {
      const outcome = await worker.hotSeat.apply(seat, intent);
      if (!outcome.ok) {
        update({ pending: false, rejection: outcome.message });
        return;
      }
      const next = { ...match, events: [...match.events, outcome.event], updatedAt: deps.now() };
      update({ match: next, pending: false });
      presenter?.setSelection([]);
      await Promise.all([refresh(), save(next)]);
    } catch (error) {
      fail(error);
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
    async start(stored, project, seatCount) {
      projectId = project;
      try {
        if (stored) {
          try {
            await begin(stored);
            return;
          } catch (error) {
            if (worker.stopped) throw error;
            update({
              notice: "The saved game no longer fits this project, so a new game started.",
            });
          }
        }
        await newGame(seatCount);
      } catch (error) {
        fail(error);
      }
    },
    newGame: (seatCount) =>
      newGame(seatCount).catch((error: unknown) => {
        fail(error);
      }),
    setViewing(viewing) {
      if (viewing === state.viewing) return;
      update({ viewing, snapshot: null, actions: [], selection: [], rejection: null });
      showSeat(viewing === "all" ? null : viewing);
      refresh().catch(fail);
    },
    setSelection(ids) {
      presenter?.setSelection(ids);
    },
    gesture(gesture) {
      if (!presenter || state.pending) return;
      void presenter.interpret(gesture).then((intent) => {
        if (intent) void apply(intent);
      });
    },
    act(intent) {
      if (intent) void apply(intent);
    },
    dismissRejection: () => update({ rejection: null }),
    destroy() {
      destroyed = true;
      unsubscribe?.();
      listeners.clear();
    },
  };
}
