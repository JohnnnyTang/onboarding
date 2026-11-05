import "fake-indexeddb/auto";
import type { HotSeatMatchRecord, LocalProject } from "@bgp/schema";
import { openDB } from "idb";
import { afterEach, describe, expect, it } from "vitest";
import { openProjectStore, type ProjectStore, StoredDataError } from "./project-store";

let counter = 0;
const open: ProjectStore[] = [];
async function store(name = `bgp-test-${++counter}`) {
  const opened = await openProjectStore(name);
  open.push(opened);
  return { store: opened, name };
}
afterEach(() => {
  for (const opened of open.splice(0)) opened.close();
});

function project(id: string, name: string, updatedAt: string): LocalProject {
  return {
    id,
    name,
    mode: "sandbox",
    manifest: {
      schemaVersion: 1,
      id: "test-game",
      name,
      version: "0.1.0",
      mode: "sandbox",
      sdk: 1,
      players: { min: 2, max: 4 },
      components: "components.json",
    },
    components: { schemaVersion: 1, defs: [], zones: [], setup: { instances: [] } },
    cardTemplates: [],
    csvSources: [],
    updatedAt,
    publishedVersionIds: [],
  };
}
const A = "0192f3a4-5b6c-7d8e-9f01-23456789aaaa";
const B = "0192f3a4-5b6c-7d8e-9f01-23456789bbbb";
const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
const asset = (projectId: string, path: string) => ({
  projectId,
  path,
  sha256: "ab".repeat(32),
  contentType: "image/png" as const,
  size: png.size,
  blob: png,
});
const match = (id: string, projectId: string, updatedAt: string): HotSeatMatchRecord => ({
  id,
  projectId,
  init: { seats: ["0", "1"], seed: 1, options: {} },
  events: [{ seq: 1, seat: "0", intent: { move: "manual", args: { op: "endTurn" } } }],
  updatedAt,
});

describe("project store", () => {
  it("lists projects newest first and reads them back", async () => {
    const { store: projects } = await store();
    await projects.putProject(project(A, "Older", "2026-11-01T00:00:00.000Z"));
    await projects.putProject(project(B, "Newer", "2026-11-02T00:00:00.000Z"));
    const list = await projects.listProjects();
    expect(list.projects.map((entry) => entry.name)).toEqual(["Newer", "Older"]);
    expect(list.unreadable).toBe(0);
    expect(await projects.getProject(A)).toEqual(project(A, "Older", "2026-11-01T00:00:00.000Z"));
    expect(await projects.getProject("0192f3a4-5b6c-7d8e-9f01-23456789cccc")).toBeNull();
  });

  it("refuses to write invalid projects and does not trust stored records", async () => {
    const { store: projects, name } = await store();
    await expect(
      projects.putProject({ ...project(A, "X y", "2026-11-01T00:00:00.000Z"), name: "" }),
    ).rejects.toThrow();
    const raw = await openDB(name);
    await raw.put("projects", { id: A, name: "tampered" });
    raw.close();
    expect(await projects.listProjects()).toEqual({ projects: [], unreadable: 1 });
    await expect(projects.getProject(A)).rejects.toBeInstanceOf(StoredDataError);
  });

  it("keeps images per project and drops records that fail validation", async () => {
    const { store: projects, name } = await store();
    await projects.putAsset(asset(A, "assets/a.png"));
    await projects.putAsset(asset(A, "assets/b.png"));
    await projects.putAsset(asset(B, "assets/a.png"));
    await expect(
      projects.putAsset({ ...asset(A, "x.svg"), contentType: "image/svg+xml" as "image/png" }),
    ).rejects.toThrow();
    await expect(projects.putAsset({ ...asset(A, "assets/c.png"), size: 99 })).rejects.toThrow();
    const raw = await openDB(name);
    await raw.put("projectAssets", { ...asset(A, "assets/z.png"), blob: "not a blob" });
    raw.close();
    const listed = await projects.listAssets(A);
    expect(listed.map((entry) => entry.path)).toEqual(["assets/a.png", "assets/b.png"]);
    expect(listed[0]?.blob.size).toBe(4);
    await projects.deleteAsset(A, "assets/a.png");
    expect((await projects.listAssets(A)).map((entry) => entry.path)).toEqual(["assets/b.png"]);
  });

  it("returns the latest hot-seat match and deletes a project with everything it owns", async () => {
    const { store: projects } = await store();
    await projects.putProject(project(A, "A", "2026-11-01T00:00:00.000Z"));
    await projects.putProject(project(B, "B", "2026-11-01T00:00:00.000Z"));
    await projects.putAsset(asset(A, "assets/a.png"));
    await projects.putAsset(asset(B, "assets/a.png"));
    const first = match("0192f3a4-5b6c-7d8e-9f01-000000000001", A, "2026-11-01T00:00:00.000Z");
    const second = match("0192f3a4-5b6c-7d8e-9f01-000000000002", A, "2026-11-03T00:00:00.000Z");
    await projects.putHotSeatMatch(first);
    await projects.putHotSeatMatch(second);
    await projects.putHotSeatMatch(
      match("0192f3a4-5b6c-7d8e-9f01-000000000003", B, "2026-11-04T00:00:00.000Z"),
    );
    expect(await projects.getHotSeatMatch(A)).toEqual(second);
    await expect(
      projects.putHotSeatMatch({ ...first, events: [], init: { seats: [], seed: 1, options: {} } }),
    ).rejects.toThrow();

    await projects.deleteProject(A);
    expect(await projects.getProject(A)).toBeNull();
    expect(await projects.listAssets(A)).toEqual([]);
    expect(await projects.getHotSeatMatch(A)).toBeNull();
    expect(await projects.getProject(B)).not.toBeNull();
    expect(await projects.listAssets(B)).toHaveLength(1);
    expect(await projects.getHotSeatMatch(B)).not.toBeNull();

    await projects.deleteHotSeatMatches(B);
    expect(await projects.getHotSeatMatch(B)).toBeNull();
  });

  it("keeps data across connections", async () => {
    const { store: first, name } = await store();
    await first.putProject(project(A, "Kept", "2026-11-01T00:00:00.000Z"));
    first.close();
    const { store: second } = await store(name);
    expect((await second.getProject(A))?.name).toBe("Kept");
  });
});
