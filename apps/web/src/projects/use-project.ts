import type { LocalProject } from "@bgp/schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServices } from "../app/services";
import { ImageImportError, readImage } from "./images";
import { projectErrors } from "./project-model";
import type { ProjectAsset } from "./project-store";

export type ProjectData =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; error: unknown }
  | { status: "ready"; project: LocalProject; assets: readonly ProjectAsset[] };

export interface ProjectEditor {
  data: ProjectData;
  /** Object URLs of the project's images, by path. */
  urls: ReadonlyMap<string, string>;
  /**
   * Applies a change to the newest saved project, after every earlier change, and saves the
   * result. Returns the problems that kept it from being saved.
   */
  save(change: (current: LocalProject) => LocalProject): Promise<string[]>;
  /**
   * Like `save`, for a change that also adds or replaces images and deletes others; all of
   * it is stored in one transaction. The change may return problems instead.
   */
  saveWithImages(change: (current: LocalProject) => ImageChange | string[]): Promise<string[]>;
  /** The newest saved project and images, after every change queued before. */
  current(): Promise<{ project: LocalProject; assets: readonly ProjectAsset[] } | null>;
  /** Imports chosen files; returns a message per file that could not be used. */
  importImages(files: readonly (Blob & { name: string })[]): Promise<string[]>;
  removeImage(path: string): Promise<void>;
}

export interface ImageChange {
  project: LocalProject;
  put: readonly ProjectAsset[];
  remove: readonly string[];
}

export function now(): string {
  return new Date().toISOString();
}

/** Object URLs for a set of images, revoked when the images change or the page leaves. */
export function useObjectUrls(assets: readonly ProjectAsset[]): ReadonlyMap<string, string> {
  const urls = useMemo(
    () => new Map(assets.map((asset) => [asset.path, URL.createObjectURL(asset.blob)])),
    [assets],
  );
  useEffect(
    () => () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
    },
    [urls],
  );
  return urls;
}

// Every read and write of projects in this tab runs in one queue, in order. A slow write
// never overwrites a newer one, and a page opened right after an edit (the hot-seat table)
// reads the project only after the edit is stored.
let queue: Promise<unknown> = Promise.resolve();

/** Runs a project store task after every task queued before it. */
export function inOrder<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

/** Loads one project with its images and saves validated edits back to IndexedDB. */
export function useProject(projectId: string): ProjectEditor {
  const { projects } = useServices();
  const [data, setData] = useState<ProjectData>({ status: "loading" });
  const latest = useRef(data);
  latest.current = data;

  useEffect(() => {
    let cancelled = false;
    setData({ status: "loading" });
    inOrder(async () => {
      const store = await projects();
      const project = await store.getProject(projectId);
      const assets = project ? await store.listAssets(projectId) : [];
      if (cancelled) return;
      setData(project ? { status: "ready", project, assets } : { status: "missing" });
    }).catch((error: unknown) => {
      if (!cancelled) setData({ status: "error", error });
    });
    return () => {
      cancelled = true;
    };
  }, [projects, projectId]);

  const assets = data.status === "ready" ? data.assets : EMPTY;
  const urls = useObjectUrls(assets);

  const save = useCallback(
    (change: (current: LocalProject) => LocalProject) =>
      inOrder(async () => {
        const current = latest.current;
        if (current.status !== "ready") return ["The project is not loaded."];
        const next = change(current.project);
        const errors = projectErrors(next);
        if (errors.length > 0) return errors;
        const stamped = { ...next, updatedAt: now() };
        await (await projects()).putProject(stamped);
        setData({ ...current, project: stamped });
        latest.current = { ...current, project: stamped };
        return [];
      }),
    [projects],
  );

  const saveWithImages = useCallback(
    (change: (current: LocalProject) => ImageChange | string[]) =>
      inOrder(async () => {
        const current = latest.current;
        if (current.status !== "ready") return ["The project is not loaded."];
        const result = change(current.project);
        if (Array.isArray(result)) return result;
        const errors = projectErrors(result.project);
        if (errors.length > 0) return errors;
        const stamped = { ...result.project, updatedAt: now() };
        await (await projects()).putProjectWithAssets(stamped, result.put, result.remove);
        const replaced = new Set([...result.remove, ...result.put.map((asset) => asset.path)]);
        const next: ProjectData = {
          status: "ready",
          project: stamped,
          assets: [...current.assets.filter((asset) => !replaced.has(asset.path)), ...result.put],
        };
        setData(next);
        latest.current = next;
        return [];
      }),
    [projects],
  );

  const current = useCallback(
    () =>
      inOrder(async () => {
        const data = latest.current;
        return data.status === "ready" ? { project: data.project, assets: data.assets } : null;
      }),
    [],
  );

  const importImages = useCallback(
    (files: readonly (Blob & { name: string })[]) =>
      inOrder(async () => {
        const current = latest.current;
        if (current.status !== "ready") return ["The project is not loaded."];
        const store = await projects();
        const added: ProjectAsset[] = [];
        const problems: string[] = [];
        const taken = current.assets.map((asset) => asset.path);
        for (const file of files) {
          try {
            const asset = await readImage(file, projectId, [...taken, ...added.map((a) => a.path)]);
            await store.putAsset(asset);
            added.push(asset);
          } catch (error) {
            problems.push(
              error instanceof ImageImportError
                ? error.message
                : `${file.name} could not be saved.`,
            );
          }
        }
        const next: ProjectData = { ...current, assets: [...current.assets, ...added] };
        setData(next);
        latest.current = next;
        return problems;
      }),
    [projects, projectId],
  );

  const removeImage = useCallback(
    (path: string) =>
      inOrder(async () => {
        const current = latest.current;
        if (current.status !== "ready") return;
        await (await projects()).deleteAsset(projectId, path);
        const next: ProjectData = {
          ...current,
          assets: current.assets.filter((asset) => asset.path !== path),
        };
        setData(next);
        latest.current = next;
      }),
    [projects, projectId],
  );

  return { data, urls, save, saveWithImages, current, importImages, removeImage };
}

const EMPTY: readonly ProjectAsset[] = [];
