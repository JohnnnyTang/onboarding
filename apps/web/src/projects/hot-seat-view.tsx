import type { ComponentsFile, SeatInfo } from "@bgp/schema";
import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { seatLabel } from "../app/messages";
import { Loading, ui } from "../components/ui";
import type { GameWorkerError } from "../match/game-worker-client";
import matchStyles from "../match/match.module.css";
import { ActionBar, Hud, ResultPanel } from "../match/match-panels";
import { preloadTable, TableView } from "../match/table-view";
import { type HotSeatController, type HotSeatState, seatsFor, type Viewing } from "./hot-seat";
import styles from "./projects.module.css";

// The hot-seat table shared by local projects (/projects/:id/play) and `bgp dev` (/dev).

const STARTING: HotSeatState = {
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

export function useHotSeatState(controller: HotSeatController | null): HotSeatState {
  const store = useMemo(
    () =>
      controller
        ? { subscribe: controller.subscribe, get: controller.getState }
        : { subscribe: () => () => {}, get: () => STARTING },
    [controller],
  );
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export interface HotSeatViewProps {
  controller: HotSeatController | null;
  components: ComponentsFile;
  assetUrl(ref: string): string;
  players: { min: number; max: number };
  /** Set when the worker could not start; shown with `failedMessage`. */
  failed: GameWorkerError | null;
  /** Shown when the game could not be loaded at all. */
  loadFailedMessage: string;
  /** Extra notes under the move counter. */
  footer?: ReactNode;
}

export function HotSeatView({
  controller,
  components,
  assetUrl,
  players,
  failed: bootFailed,
  loadFailedMessage,
  footer,
}: HotSeatViewProps) {
  const hotSeat = useHotSeatState(controller);
  const [seatCount, setSeatCount] = useState<number | null>(null);
  useEffect(() => {
    void preloadTable().catch(() => {});
  }, []);

  const match = hotSeat.match;
  const seats = match?.init.seats ?? [];
  const seatInfo: SeatInfo[] = seats.map((seat) => ({
    seat,
    name: "",
    connected: true,
    guest: false,
  }));
  const viewing = hotSeat.viewing;
  const { min, max } = players;
  const chosenCount = seatCount ?? (seats.length || min);
  const failed = bootFailed ?? (hotSeat.status === "failed" ? hotSeat.error : null);
  const result = hotSeat.view?.result ?? null;

  return (
    <>
      {failed ? (
        <p className={ui.notice} role="alert">
          {failed.reason === "load" ? loadFailedMessage : failed.message}
        </p>
      ) : null}
      {hotSeat.notice ? (
        <p className={ui.muted} role="status">
          {hotSeat.notice}
        </p>
      ) : null}
      <fieldset className={styles.seatSwitcher}>
        <legend>Viewing</legend>
        {seats.map((seat) => (
          <button
            key={seat}
            type="button"
            aria-pressed={viewing === seat}
            className={`${ui.button} ${viewing === seat ? "" : ui.secondary}`}
            onClick={() => controller?.setViewing(seat)}
          >
            {seatLabel(seat)}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={viewing === "all"}
          className={`${ui.button} ${viewing === "all" ? "" : ui.secondary}`}
          onClick={() => controller?.setViewing("all" satisfies Viewing)}
        >
          All seats
        </button>
      </fieldset>
      <div className={matchStyles.layout}>
        <div>
          {hotSeat.status === "starting" && !failed ? (
            <Loading label="Setting up the table…" />
          ) : (
            <TableView
              components={components}
              assetUrl={assetUrl}
              seat={viewing === "all" ? null : viewing}
              snapshot={hotSeat.snapshot}
              selection={hotSeat.selection}
              onGesture={(gesture) => controller?.gesture(gesture)}
              onSelectionChange={(ids) => controller?.setSelection(ids)}
            />
          )}
        </div>
        <aside className={matchStyles.side} aria-label="Hot-seat">
          {viewing === "all" ? (
            <p className={ui.muted}>
              All seats: everything any seat may see. Items nobody may see stay hidden. Choose a
              seat to make moves.
            </p>
          ) : null}
          {result ? (
            <ResultPanel
              result={result}
              seats={seatInfo}
              mySeat={viewing === "all" ? null : viewing}
            />
          ) : null}
          {hotSeat.snapshot?.prompt ? (
            <p className={matchStyles.prompt} aria-live="polite">
              {hotSeat.snapshot.prompt}
            </p>
          ) : null}
          {hotSeat.rejection ? (
            <div className={matchStyles.rejected} role="alert">
              <span>{hotSeat.rejection}</span>
              <button
                type="button"
                className={matchStyles.dismiss}
                aria-label="Dismiss"
                onClick={() => controller?.dismissRejection()}
              >
                ×
              </button>
            </div>
          ) : null}
          <ActionBar
            actions={result ? [] : hotSeat.actions}
            disabled={hotSeat.pending || hotSeat.status !== "ready"}
            onAction={(action) => controller?.act(action.intent)}
          />
          <Hud
            entries={hotSeat.snapshot?.hud ?? []}
            seats={seatInfo}
            mySeat={viewing === "all" ? null : viewing}
          />
          <form
            className={styles.newGame}
            onSubmit={(event) => {
              event.preventDefault();
              void controller?.newGame(chosenCount);
            }}
          >
            <label htmlFor="seat-count">Players</label>
            <select
              id="seat-count"
              value={chosenCount}
              onChange={(event) => setSeatCount(Number(event.target.value))}
            >
              {seatsFor(max)
                .slice(min - 1)
                .map((seat) => (
                  <option key={seat} value={Number(seat) + 1}>
                    {Number(seat) + 1}
                  </option>
                ))}
            </select>
            <button
              type="submit"
              className={`${ui.button} ${ui.secondary}`}
              disabled={!controller || hotSeat.pending}
            >
              New game
            </button>
          </form>
          {match ? (
            <p className={ui.muted}>
              {match.events.length} {match.events.length === 1 ? "move" : "moves"} so far
              {footer ? <>, {footer}</> : "."}
            </p>
          ) : null}
        </aside>
      </div>
    </>
  );
}
