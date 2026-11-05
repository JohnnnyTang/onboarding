import {
  type HotSeatMatchRecord,
  HotSeatMatchRecordSchema,
  type LocalProject,
  LocalProjectSchema,
  type ProjectAssetInfo,
  ProjectAssetInfoSchema,
} from "@bgp/schema";
import { type DBSchema, type IDBPDatabase, openDB } from "idb";

// The browser's `bgp` database (data-model.md). Projects never leave this device until the
// designer publishes them (D-015). Every record read back is validated: storage is a trust
// boundary (AGENTS.md rule 8), and an older or edited record must not crash the editor.

export const DATABASE_NAME = "bgp";
const DATABASE_VERSION = 1;

/** An image of a project with its bytes. */
export interface ProjectAsset extends ProjectAssetInfo {
  blob: Blob;
}

interface BgpDatabase extends DBSchema {
  projects: { key: string; value: unknown };
  projectAssets: { key: [string, string]; value: unknown };
  hotseatMatches: { key: string; value: unknown; indexes: { projectId: string } };
}

/** A stored record failed validation; its contents are never shown. */
export class StoredDataError extends Error {
  override readonly name = "StoredDataError";
  constructor() {
    super("This project's saved data could not be read.");
  }
}

export interface ProjectList {
  projects: LocalProject[];
  /** Records that failed validation and are left untouched. */
  unreadable: number;
}

export interface ProjectStore {
  /** Most recently changed first. */
  listProjects(): Promise<ProjectList>;
  getProject(id: string): Promise<LocalProject | null>;
  putProject(project: LocalProject): Promise<void>;
  /** Saves the project, adds or replaces images and deletes others, in one transaction. */
  putProjectWithAssets(
    project: LocalProject,
    put: readonly ProjectAsset[],
    remove: readonly string[],
  ): Promise<void>;
  /** Deletes the project with its images and hot-seat matches. */
  deleteProject(id: string): Promise<void>;
  listAssets(projectId: string): Promise<ProjectAsset[]>;
  putAsset(asset: ProjectAsset): Promise<void>;
  deleteAsset(projectId: string, path: string): Promise<void>;
  /** The project's most recent hot-seat match. */
  getHotSeatMatch(projectId: string): Promise<HotSeatMatchRecord | null>;
  putHotSeatMatch(match: HotSeatMatchRecord): Promise<void>;
  deleteHotSeatMatches(projectId: string): Promise<void>;
  close(): void;
}

function parseProject(value: unknown): LocalProject {
  const parsed = LocalProjectSchema.safeParse(value);
  if (!parsed.success) throw new StoredDataError();
  return parsed.data;
}

function parseAsset(value: unknown): ProjectAsset | null {
  if (typeof value !== "object" || value === null) return null;
  const { blob, ...info } = value as Record<string, unknown>;
  const parsed = ProjectAssetInfoSchema.safeParse(info);
  if (!parsed.success || !(blob instanceof Blob) || blob.size !== parsed.data.size) return null;
  return { ...parsed.data, blob };
}

/** The record stored for an asset, validated, with its bytes. */
function assetRecord(asset: ProjectAsset): ProjectAssetInfo & { blob: Blob } {
  const { blob, ...info } = asset;
  const parsed = ProjectAssetInfoSchema.parse(info);
  if (blob.size !== parsed.size) throw new Error("Asset size does not match its bytes");
  return { ...parsed, blob };
}

function assetRange(projectId: string): IDBKeyRange {
  // Paths use only [A-Za-z0-9._/-], so "￿" sorts after every path of the project.
  return IDBKeyRange.bound([projectId, ""], [projectId, "￿"]);
}

export async function openProjectStore(name = DATABASE_NAME): Promise<ProjectStore> {
  const db: IDBPDatabase<BgpDatabase> = await openDB<BgpDatabase>(name, DATABASE_VERSION, {
    upgrade(database) {
      database.createObjectStore("projects", { keyPath: "id" });
      database.createObjectStore("projectAssets", { keyPath: ["projectId", "path"] });
      database
        .createObjectStore("hotseatMatches", { keyPath: "id" })
        .createIndex("projectId", "projectId");
    },
    // Another tab needs a newer version: close so it can upgrade.
    blocking(_current, _next, event) {
      (event.target as IDBDatabase).close();
    },
  });

  return {
    async listProjects() {
      const projects: LocalProject[] = [];
      let unreadable = 0;
      for (const value of await db.getAll("projects")) {
        const parsed = LocalProjectSchema.safeParse(value);
        if (parsed.success) projects.push(parsed.data);
        else unreadable += 1;
      }
      projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
      return { projects, unreadable };
    },
    async getProject(id) {
      const value = await db.get("projects", id);
      return value === undefined ? null : parseProject(value);
    },
    async putProject(project) {
      await db.put("projects", LocalProjectSchema.parse(project));
    },
    async putProjectWithAssets(project, put, remove) {
      const parsed = LocalProjectSchema.parse(project);
      const records = put.map(assetRecord);
      if (records.some((record) => record.projectId !== parsed.id)) {
        throw new Error("Assets belong to another project");
      }
      const tx = db.transaction(["projects", "projectAssets"], "readwrite");
      const assets = tx.objectStore("projectAssets");
      await Promise.all([
        tx.objectStore("projects").put(parsed),
        ...remove.map((path) => assets.delete([parsed.id, path])),
        ...records.map((record) => assets.put(record)),
      ]);
      await tx.done;
    },
    async deleteProject(id) {
      const tx = db.transaction(["projects", "projectAssets", "hotseatMatches"], "readwrite");
      const matches = tx.objectStore("hotseatMatches");
      await Promise.all([
        tx.objectStore("projects").delete(id),
        tx.objectStore("projectAssets").delete(assetRange(id)),
        ...(await matches.index("projectId").getAllKeys(id)).map((key) => matches.delete(key)),
      ]);
      await tx.done;
    },
    async listAssets(projectId) {
      const values = await db.getAll("projectAssets", assetRange(projectId));
      return values.flatMap((value) => {
        const asset = parseAsset(value);
        return asset ? [asset] : [];
      });
    },
    async putAsset(asset) {
      await db.put("projectAssets", assetRecord(asset));
    },
    async deleteAsset(projectId, path) {
      await db.delete("projectAssets", [projectId, path]);
    },
    async getHotSeatMatch(projectId) {
      const values = await db.getAllFromIndex("hotseatMatches", "projectId", projectId);
      const matches = values.flatMap((value) => {
        const parsed = HotSeatMatchRecordSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      });
      matches.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return matches[0] ?? null;
    },
    async putHotSeatMatch(match) {
      await db.put("hotseatMatches", HotSeatMatchRecordSchema.parse(match));
    },
    async deleteHotSeatMatches(projectId) {
      const tx = db.transaction("hotseatMatches", "readwrite");
      const keys = await tx.store.index("projectId").getAllKeys(projectId);
      await Promise.all(keys.map((key) => tx.store.delete(key)));
      await tx.done;
    },
    close: () => db.close(),
  };
}
