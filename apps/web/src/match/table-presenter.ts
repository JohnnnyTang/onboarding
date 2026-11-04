import type {
  ActionButton,
  ClientView,
  Gesture,
  MoveIntent,
  SeatId,
  TableSnapshot,
} from "@bgp/schema";
import { type GameWorker, GameWorkerError } from "./game-worker-client";

export interface TableState {
  /** The last snapshot `present` returned for the current view, or null before the first. */
  snapshot: TableSnapshot | null;
  actions: readonly ActionButton[];
  selection: readonly string[];
  /** Set when game code failed; the table keeps its last good snapshot. */
  error: GameWorkerError | null;
}

export interface TablePresenter {
  getState(): TableState;
  subscribe(listener: () => void): () => void;
  setView(view: ClientView): void;
  setSelection(ids: readonly string[]): void;
  /** The move a gesture stands for, or null when the game does not turn it into one. */
  interpret(gesture: Gesture): Promise<MoveIntent | null>;
}

type Presentation = Pick<GameWorker, "present" | "interpret" | "actions">;

/**
 * Runs the presentation side of a game for one viewing seat: view → `present` → snapshot,
 * view and selection → `actions`, and gestures → `interpret`. Calls are asynchronous, so a
 * result is applied only if no newer view or selection arrived meanwhile.
 */
export function createTablePresenter(worker: Presentation, seat: SeatId | null): TablePresenter {
  let state: TableState = { snapshot: null, actions: [], selection: [], error: null };
  const listeners = new Set<() => void>();
  let view: ClientView | null = null;
  let viewRevision = 0;
  let actionsRevision = 0;

  function update(patch: Partial<TableState>) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }

  function fail(error: unknown) {
    update({ error: error instanceof GameWorkerError ? error : new GameWorkerError("failed") });
  }

  function refreshActions() {
    if (!view) return;
    const revision = ++actionsRevision;
    worker.actions(view, seat, [...state.selection]).then(
      (actions) => {
        if (revision === actionsRevision) update({ actions });
      },
      (error: unknown) => {
        if (revision === actionsRevision) fail(error);
      },
    );
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setView(next) {
      view = next;
      const revision = ++viewRevision;
      worker.present(next, seat).then(
        (snapshot) => {
          if (revision !== viewRevision) return;
          // Keep only selected items that are still selectable in the new snapshot.
          const selectable = new Set(
            snapshot.items.filter((item) => item.selectable).map((item) => item.id),
          );
          const selection = state.selection.filter((id) => selectable.has(id));
          update({ snapshot, selection, error: null });
          refreshActions();
        },
        (error: unknown) => {
          if (revision === viewRevision) fail(error);
        },
      );
    },
    setSelection(ids) {
      const selection = [...new Set(ids)];
      if (JSON.stringify(selection) === JSON.stringify(state.selection)) return;
      update({ selection });
      refreshActions();
    },
    async interpret(gesture) {
      if (!view) return null;
      try {
        return await worker.interpret(gesture, view, seat);
      } catch (error) {
        fail(error);
        return null;
      }
    },
  };
}
