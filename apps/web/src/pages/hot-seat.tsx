import type { LocalProject, SeatInfo } from "@bgp/schema";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Link, useParams } from "react-router";
import { seatLabel } from "../app/messages";
import { useServices } from "../app/services";
import { EmptyState, Loading, PageHeader, ui } from "../components/ui";
import { bootGameWorker, GameWorkerError } from "../match/game-worker-client";
import matchStyles from "../match/match.module.css";
import { ActionBar, Hud, ResultPanel } from "../match/match-panels";
import { preloadTable, TableView } from "../match/table-view";
import {
  createHotSeat,
  type HotSeatController,
  type HotSeatState,
  seatsFor,
  type Viewing,
} from "../projects/hot-seat";
import styles from "../projects/projects.module.css";
import { now, useProject } from "../projects/use-project";
import { projectPath } from "./projects";

function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
}

/** Boots the game worker with the built-in sandbox game and runs one hot-seat match. */
function useHotSeat(project: LocalProject | null): HotSeatController | null | "failed" {
  const { projects } = useServices();
  const [controller, setController] = useState<HotSeatController | null | "failed">(null);
  const components = project?.components;
  const projectId = project?.id;
  const minPlayers = project?.manifest.players.min ?? 1;
  useEffect(() => {
    if (!components || !projectId) return;
    let cancelled = false;
    let hotSeat: HotSeatController | null = null;
    const booting = bootGameWorker();
    (async () => {
      const store = await projects();
      const [booted, stored] = await Promise.all([booting, store.getHotSeatMatch(projectId)]);
      const worker = await booted.load({ kind: "sandbox" }, components);
      if (cancelled) {
        worker.destroy();
        return;
      }
      hotSeat = createHotSeat({
        worker,
        persist: (match) => store.putHotSeatMatch(match),
        newId: () => crypto.randomUUID(),
        newSeed: randomSeed,
        now,
      });
      setController(hotSeat);
      await hotSeat.start(stored, projectId, minPlayers);
    })().catch(() => {
      if (!cancelled) setController("failed");
    });
    return () => {
      cancelled = true;
      hotSeat?.destroy();
      void booting.then(
        (booted) => booted.destroy(),
        () => {},
      );
      setController(null);
    };
  }, [projects, projectId, components, minPlayers]);
  return controller;
}

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

function useHotSeatState(controller: HotSeatController | null): HotSeatState {
  const store = useMemo(
    () =>
      controller
        ? { subscribe: controller.subscribe, get: controller.getState }
        : { subscribe: () => () => {}, get: () => STARTING },
    [controller],
  );
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** `/projects/:projectId/play`: every seat plays on this device, one at a time. */
export function HotSeatPage() {
  const { projectId = "" } = useParams();
  const editor = useProject(projectId);
  const project = editor.data.status === "ready" ? editor.data.project : null;
  const controller = useHotSeat(project);
  const hotSeat = useHotSeatState(typeof controller === "object" ? controller : null);
  const [seatCount, setSeatCount] = useState<number | null>(null);
  useEffect(() => {
    void preloadTable().catch(() => {});
  }, []);

  const urls = editor.urls;
  const assetUrl = useCallback(
    (ref: string) => {
      const url = urls.get(ref);
      // The renderer draws a labeled placeholder when an image is missing.
      if (url === undefined) throw new Error("Image not imported");
      return url;
    },
    [urls],
  );

  if (editor.data.status === "loading") return <Loading label="Opening the project…" />;
  if (!project) {
    return (
      <>
        <PageHeader title="Hot-seat" />
        <EmptyState title="This project is not on this device">
          <p>
            <Link to="/projects">Back to projects</Link>
          </p>
        </EmptyState>
      </>
    );
  }

  const active = typeof controller === "object" ? controller : null;
  const match = hotSeat.match;
  const seats = match?.init.seats ?? [];
  const seatInfo: SeatInfo[] = seats.map((seat) => ({
    seat,
    name: "",
    connected: true,
    guest: false,
  }));
  const viewing = hotSeat.viewing;
  const { min, max } = project.manifest.players;
  const chosenCount = seatCount ?? (seats.length || min);
  const failed =
    controller === "failed" || hotSeat.status === "failed"
      ? (hotSeat.error ?? new GameWorkerError("load"))
      : null;
  const result = hotSeat.view?.result ?? null;

  return (
    <>
      <PageHeader title={`${project.name}: hot-seat`}>
        Every seat plays on this device. Switch seats to see what each player sees.{" "}
        <Link to={projectPath(project.id)}>Edit the project</Link>
      </PageHeader>
      {failed ? (
        <p className={ui.notice} role="alert">
          {failed.reason === "load"
            ? "The table could not be set up from this project."
            : failed.message}
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
            onClick={() => active?.setViewing(seat)}
          >
            {seatLabel(seat)}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={viewing === "all"}
          className={`${ui.button} ${viewing === "all" ? "" : ui.secondary}`}
          onClick={() => active?.setViewing("all" satisfies Viewing)}
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
              components={project.components}
              assetUrl={assetUrl}
              seat={viewing === "all" ? null : viewing}
              snapshot={hotSeat.snapshot}
              selection={hotSeat.selection}
              onGesture={(gesture) => active?.gesture(gesture)}
              onSelectionChange={(ids) => active?.setSelection(ids)}
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
                onClick={() => active?.dismissRejection()}
              >
                ×
              </button>
            </div>
          ) : null}
          <ActionBar
            actions={result ? [] : hotSeat.actions}
            disabled={hotSeat.pending || hotSeat.status !== "ready"}
            onAction={(action) => active?.act(action.intent)}
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
              void active?.newGame(chosenCount);
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
              disabled={!active || hotSeat.pending}
            >
              New game
            </button>
          </form>
          {match ? (
            <p className={ui.muted}>
              {match.events.length} {match.events.length === 1 ? "move" : "moves"} so far, saved on
              this device.
            </p>
          ) : null}
        </aside>
      </div>
    </>
  );
}
