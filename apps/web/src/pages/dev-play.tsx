import { type DevGameResponse, defaultOptions } from "@bgp/schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { EmptyState, Loading, PageHeader, ui } from "../components/ui";
import {
  DevServerError,
  devAssetUrl,
  devServerOrigin,
  fetchDevGame,
  loadDevMatch,
  saveDevMatch,
  watchDevBuilds,
} from "../dev/dev-game";
import { bootGameWorker, GameWorkerError } from "../match/game-worker-client";
import { createHotSeat, type HotSeatController, randomSeed } from "../projects/hot-seat";
import { HotSeatView } from "../projects/hot-seat-view";
import { now } from "../projects/use-project";

/** The latest build from `bgp dev`, and the latest one that can be played. */
function useDevGame(origin: string | null) {
  const [latest, setLatest] = useState<DevGameResponse | null>(null);
  const [playable, setPlayable] = useState<DevGameResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!origin) return;
    let stopped = false;
    let seen = -1;
    const refresh = () => {
      fetchDevGame(origin).then(
        (game) => {
          if (stopped || game.buildId === seen) return;
          seen = game.buildId;
          setError(null);
          setLatest(game);
          if (game.errors.length === 0) setPlayable(game);
        },
        (failure: unknown) => {
          if (!stopped) {
            setError(failure instanceof DevServerError ? failure.message : "bgp dev failed");
          }
        },
      );
    };
    refresh();
    const stop = watchDevBuilds(origin, refresh);
    return () => {
      stopped = true;
      stop();
    };
  }, [origin]);
  return { latest, playable, error };
}

/**
 * Runs the playable build in a fresh game worker and resumes this tab's match by replaying its
 * events. A new build replaces the worker; the match carries over through session storage.
 */
function useDevHotSeat(game: DevGameResponse | null): HotSeatController | null | "failed" {
  const [controller, setController] = useState<HotSeatController | null | "failed">(null);
  const projectId = useRef(crypto.randomUUID());
  useEffect(() => {
    if (!game) return;
    let cancelled = false;
    let hotSeat: HotSeatController | null = null;
    const gameId = game.manifest.id;
    const booting = bootGameWorker();
    (async () => {
      const booted = await booting;
      const source =
        game.source === null
          ? { kind: "sandbox" as const }
          : { kind: "bundle" as const, source: game.source };
      const worker = await booted.load(source, game.components);
      if (cancelled) {
        worker.destroy();
        return;
      }
      hotSeat = createHotSeat({
        worker,
        persist: (match) => saveDevMatch(match, gameId),
        newId: () => crypto.randomUUID(),
        newSeed: randomSeed,
        now,
        options: defaultOptions(game.manifest),
      });
      setController(hotSeat);
      const stored = loadDevMatch(gameId);
      await hotSeat.start(
        stored,
        stored?.projectId ?? projectId.current,
        game.manifest.players.min,
      );
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
  }, [game]);
  return controller;
}

/** `/dev?game=<origin>`: the hot-seat table for a game served by `bgp dev`. */
export function DevPlayPage() {
  const [params] = useSearchParams();
  const origin = devServerOrigin(params.get("game"));
  const { latest, playable, error } = useDevGame(origin);
  const controller = useDevHotSeat(playable);
  const buildId = playable?.buildId ?? 0;
  const assetUrl = useCallback(
    (ref: string) => (origin ? devAssetUrl(origin, ref, buildId) : ref),
    [origin, buildId],
  );

  if (!origin) {
    return (
      <>
        <PageHeader title="bgp dev" />
        <EmptyState title="No game to show">
          <p>
            Run <code>bgp dev</code> in a game package and open the link it prints. This page
            accepts only a <code>bgp dev</code> server on this computer.
          </p>
        </EmptyState>
      </>
    );
  }
  const errors = latest?.errors ?? [];
  return (
    <>
      <PageHeader title={playable ? `${playable.manifest.name}: bgp dev` : "bgp dev"}>
        Hot-seat table for the game served at {origin}. It reloads when you save a file and replays
        the current game.
      </PageHeader>
      {error ? (
        <p className={ui.notice} role="alert">
          {error}
        </p>
      ) : null}
      {errors.length > 0 ? (
        <div className={ui.notice} role="alert">
          <p>
            Build {latest?.buildId} failed
            {playable ? `; the table still runs build ${playable.buildId}` : ""}:
          </p>
          <ul>
            {errors.map((item) => (
              <li key={`${item.path}:${item.message}`}>
                {item.path ? `${item.path}: ` : ""}
                {item.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {playable ? (
        <>
          <p className={ui.muted} role="status" aria-live="polite">
            Build {playable.buildId} of {playable.manifest.id} {playable.manifest.version}
          </p>
          <HotSeatView
            controller={typeof controller === "object" ? controller : null}
            components={playable.components}
            assetUrl={assetUrl}
            players={playable.manifest.players}
            failed={controller === "failed" ? new GameWorkerError("load") : null}
            loadFailedMessage="This build could not be loaded in the game worker. Run bgp validate for details."
            footer="kept in this tab across reloads."
          />
        </>
      ) : error ? null : (
        <Loading label="Loading the game from bgp dev…" />
      )}
    </>
  );
}
