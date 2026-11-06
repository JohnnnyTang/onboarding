import type { ReplayResponse, SeatInfo } from "@bgp/schema";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Link, useParams } from "react-router";
import type { ApiClient } from "../api/client";
import { seatLabel } from "../app/messages";
import { useAuthUser, useServices } from "../app/services";
import { EmptyState, ErrorNotice, Loading, PageHeader, SignInButton, ui } from "../components/ui";
import { type GamePackage, loadGamePackage } from "../match/game-package";
import { bootGameWorker } from "../match/game-worker-client";
import styles from "../match/match.module.css";
import { Hud, playerName, ResultPanel } from "../match/match-panels";
import {
  createReplayViewer,
  type HashCheck,
  type ReplayController,
  type ReplayState,
} from "../match/replay-viewer";
import { preloadTable, TableView } from "../match/table-view";
import { gameErrorMessage } from "./match";

type Loaded =
  | { kind: "loading" }
  | { kind: "ready"; pkg: GamePackage; viewer: ReplayController }
  | { kind: "error"; error: unknown };

/** Downloads the version, starts its game worker and rebuilds the match in it. */
function useReplayViewer(
  api: ApiClient,
  matchId: string,
  versionId: string | undefined,
  replay: ReplayResponse | undefined,
): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  useEffect(() => {
    if (versionId === undefined || replay === undefined) return;
    let cancelled = false;
    let viewer: ReplayController | null = null;
    setLoaded({ kind: "loading" });
    const booting = bootGameWorker();
    const loading = loadGamePackage(api, versionId, matchId);
    (async () => {
      const [booted, pkg] = await Promise.all([booting, loading]);
      if (cancelled) return;
      const worker = await booted.load(pkg.game, pkg.components);
      if (cancelled) return;
      viewer = createReplayViewer(worker, replay);
      setLoaded({ kind: "ready", pkg, viewer });
      await viewer.load();
    })().catch((error: unknown) => {
      if (!cancelled) setLoaded({ kind: "error", error });
    });
    return () => {
      cancelled = true;
      viewer?.destroy();
      void booting.then(
        (booted) => booted.destroy(),
        () => {},
      );
      void loading.then(
        (pkg) => pkg.dispose(),
        () => {},
      );
    };
  }, [api, matchId, versionId, replay]);
  return loaded;
}

function useReplayState(viewer: ReplayController | null): ReplayState | null {
  const store = useMemo(
    () =>
      viewer
        ? { subscribe: viewer.subscribe, get: viewer.getState }
        : { subscribe: () => () => {}, get: () => null },
    [viewer],
  );
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

const shortHash = (hash: string) => `${hash.slice(0, 12)}…`;

export function HashCheckNotice({ check }: { check: HashCheck }) {
  switch (check.status) {
    case "pending":
      return null;
    case "match":
      return (
        <p className={ui.muted} role="status" data-testid="hash-check" data-hash={check.hash}>
          Final state checked: its hash matches the server's ({shortHash(check.hash)}).
        </p>
      );
    case "mismatch":
      return (
        <p className={ui.notice} role="alert" data-testid="hash-check" data-hash={check.hash}>
          The replayed final state differs from the server's: {shortHash(check.hash)} here,{" "}
          {shortHash(check.expected)} on the server. This replay may not show what happened.
        </p>
      );
    case "unavailable":
      return (
        <p className={ui.muted} role="status" data-testid="hash-check">
          The final state could not be checked in this browser.
        </p>
      );
  }
}

/** "Setup", or who made the move that led to this step. */
export function stepCaption(replay: ReplayResponse, seq: number, seats: readonly SeatInfo[]) {
  const event = replay.events[seq - 1];
  if (seq === 0 || !event) return "Setup";
  // Sandbox moves are all "manual"; the operation says more.
  const args = event.intent.args;
  const op =
    event.intent.move === "manual" && typeof args === "object" && args !== null && "op" in args
      ? args.op
      : undefined;
  return `${playerName(event.seat, seats)}: ${typeof op === "string" ? op : event.intent.move}`;
}

function StepControls({
  state,
  viewer,
  caption,
}: {
  state: ReplayState;
  viewer: ReplayController;
  caption: string;
}) {
  const { seq, total } = state;
  const disabled = state.status !== "ready";
  return (
    <section className={styles.replaySteps} aria-label="Steps">
      <p
        className={styles.prompt}
        data-testid="replay-step"
        data-step={seq}
        data-shown={state.shownSeq ?? ""}
      >
        Move {seq} of {total} · {caption}
      </p>
      <input
        type="range"
        aria-label="Step"
        min={0}
        max={total}
        value={seq}
        disabled={disabled}
        onChange={(event) => viewer.goTo(Number(event.target.value))}
      />
      <div className={styles.actions}>
        <button
          type="button"
          className={`${ui.button} ${ui.secondary}`}
          disabled={disabled || seq === 0}
          onClick={() => viewer.goTo(0)}
        >
          Setup
        </button>
        <button
          type="button"
          className={`${ui.button} ${ui.secondary}`}
          disabled={disabled || seq === 0}
          onClick={() => viewer.step(-1)}
        >
          Back
        </button>
        <button
          type="button"
          className={ui.button}
          disabled={disabled || seq === total}
          onClick={() => viewer.step(1)}
        >
          Forward
        </button>
        <button
          type="button"
          className={`${ui.button} ${ui.secondary}`}
          disabled={disabled || seq === total}
          onClick={() => viewer.goTo(total)}
        >
          End
        </button>
      </div>
    </section>
  );
}

/** `/matches/:matchId/replay`: step through a finished match from its log. */
export function ReplayPage() {
  const { matchId = "" } = useParams();
  const { api, seats } = useServices();
  const user = useAuthUser();
  const claimed = seats.get(matchId);
  const identity = claimed?.guestToken ? `guest:${claimed.seat}` : user?.subject;
  const match = useQuery({
    queryKey: ["match", matchId, identity],
    queryFn: () => api.getMatch(matchId),
    enabled: identity !== undefined,
  });
  const finished = match.data?.status === "finished";
  const replay = useQuery({
    queryKey: ["replay", matchId, identity],
    queryFn: () => api.getReplay(matchId),
    enabled: identity !== undefined && finished,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const loaded = useReplayViewer(api, matchId, match.data?.versionId, replay.data);
  const viewer = loaded.kind === "ready" ? loaded.viewer : null;
  const state = useReplayState(viewer);
  useEffect(() => {
    void preloadTable().catch(() => {});
  }, []);

  if (identity === undefined) {
    return (
      <>
        <PageHeader title="Replay" />
        <EmptyState title="You are not in this match">
          <p>Replays are for the match's players and its host. Hosts sign in to see them.</p>
          <SignInButton />
        </EmptyState>
      </>
    );
  }
  if (match.isError || replay.isError) {
    return (
      <>
        <PageHeader title="Replay" />
        <ErrorNotice error={match.error ?? replay.error} />
        <p>
          <Link to="/matches">Back to matches</Link>
        </p>
      </>
    );
  }
  if (match.data && !finished) {
    return (
      <>
        <PageHeader title="Replay" />
        <EmptyState title="This match has no replay">
          <p>
            {match.data.status === "abandoned"
              ? "The host ended this match before it finished."
              : "The replay is ready once the match has finished."}{" "}
            <Link to={`/matches/${encodeURIComponent(matchId)}/lobby`}>Go to the lobby</Link>
          </p>
        </EmptyState>
      </>
    );
  }

  const seatInfo = match.data?.seats ?? [];
  const mySeat = claimed?.seat ?? null;
  const failure = loaded.kind === "error" ? loaded.error : (state?.error ?? null);
  const title = loaded.kind === "ready" ? `${loaded.pkg.manifest.name}: replay` : "Replay";
  const viewing = state?.viewing ?? "all";
  const result = state?.shownSeq === state?.total ? (state?.view?.result ?? null) : null;

  return (
    <>
      <PageHeader title={title}>
        Step through the match as any seat saw it, or as all seats together.
      </PageHeader>
      {failure ? (
        <p className={ui.notice} role="alert">
          {gameErrorMessage(failure)} The replay could not be rebuilt.
        </p>
      ) : null}
      {state?.status === "loading" ? (
        <Loading label={`Rebuilding the match: ${state.loaded} of ${state.total} moves…`} />
      ) : null}
      {state ? <HashCheckNotice check={state.hashCheck} /> : null}
      <fieldset className={styles.replayViewing}>
        <legend>Viewing</legend>
        {(replay.data?.seats ?? []).map((seat) => (
          <button
            key={seat}
            type="button"
            aria-pressed={viewing === seat}
            className={`${ui.button} ${viewing === seat ? "" : ui.secondary}`}
            disabled={!viewer}
            onClick={() => viewer?.setViewing(seat)}
          >
            {seatLabel(seat)}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={viewing === "all"}
          className={`${ui.button} ${viewing === "all" ? "" : ui.secondary}`}
          disabled={!viewer}
          onClick={() => viewer?.setViewing("all")}
        >
          All seats
        </button>
      </fieldset>
      <div className={styles.layout}>
        <div>
          {loaded.kind === "ready" && state?.status === "ready" ? (
            <TableView
              components={loaded.pkg.components}
              assetUrl={loaded.pkg.assetUrl}
              seat={viewing === "all" ? null : viewing}
              snapshot={state.snapshot}
              selection={[]}
              onGesture={() => {}}
              onSelectionChange={() => {}}
            />
          ) : failure ? null : (
            <Loading label="Setting up the table…" />
          )}
        </div>
        <aside className={styles.side} aria-label="Replay">
          {state && viewer && replay.data ? (
            <StepControls
              state={state}
              viewer={viewer}
              caption={stepCaption(replay.data, state.seq, seatInfo)}
            />
          ) : null}
          {viewing === "all" ? (
            <p className={ui.muted}>
              All seats: everything any seat could see. Items nobody could see stay hidden.
            </p>
          ) : null}
          {result ? <ResultPanel result={result} seats={seatInfo} mySeat={mySeat} /> : null}
          <Hud entries={state?.snapshot?.hud ?? []} seats={seatInfo} mySeat={mySeat} />
        </aside>
      </div>
    </>
  );
}
