import type { LocalProject } from "@bgp/schema";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { useServices } from "../app/services";
import { EmptyState, Loading, PageHeader } from "../components/ui";
import { bootGameWorker, GameWorkerError } from "../match/game-worker-client";
import { createHotSeat, type HotSeatController, randomSeed } from "../projects/hot-seat";
import { HotSeatView } from "../projects/hot-seat-view";
import { now, useProject } from "../projects/use-project";
import { projectPath } from "./projects";

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

/** `/projects/:projectId/play`: every seat plays on this device, one at a time. */
export function HotSeatPage() {
  const { projectId = "" } = useParams();
  const editor = useProject(projectId);
  const project = editor.data.status === "ready" ? editor.data.project : null;
  const controller = useHotSeat(project);

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
  return (
    <>
      <PageHeader title={`${project.name}: hot-seat`}>
        Every seat plays on this device. Switch seats to see what each player sees.{" "}
        <Link to={projectPath(project.id)}>Edit the project</Link>
      </PageHeader>
      <HotSeatView
        controller={active}
        components={project.components}
        assetUrl={assetUrl}
        players={project.manifest.players}
        failed={controller === "failed" ? new GameWorkerError("load") : null}
        loadFailedMessage="The table could not be set up from this project."
        footer="saved on this device."
      />
    </>
  );
}
