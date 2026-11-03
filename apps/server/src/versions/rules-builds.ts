import type { BuildStore, RulesHostClient } from "@bgp/rules-host";
import type { HostBuild } from "@bgp/schema";
import { and, eq } from "drizzle-orm";
import { type BlobStore, blobKey } from "../blob/blob-store.js";
import type { Database } from "../db/connection.js";
import { gameVersions, versionFiles } from "../db/schema.js";
import type { SetupChecker } from "./finalize.js";

export interface VersionBuildStore extends BuildStore {
  /** Make a build being finalized loadable for the duration of `run`. */
  staged<T>(buildHash: string, build: HostBuild, run: () => Promise<T>): Promise<T>;
}

/**
 * Resolves build hashes for the rules host: ready enforced versions from the database
 * and blob store, plus builds staged while finalize runs their setup check.
 * The host client re-verifies the file index and entry digest of everything returned.
 */
export function createVersionBuildStore(db: Database, blobs: BlobStore): VersionBuildStore {
  const staging = new Map<string, { build: HostBuild; users: number }>();
  return {
    async staged(buildHash, build, run) {
      const entry = staging.get(buildHash) ?? { build, users: 0 };
      entry.users++;
      staging.set(buildHash, entry);
      try {
        return await run();
      } finally {
        entry.users--;
        if (entry.users === 0) staging.delete(buildHash);
      }
    },
    async load(buildHash) {
      const pending = staging.get(buildHash);
      if (pending) return pending.build;
      const [version] = await db
        .select({ id: gameVersions.id, manifest: gameVersions.manifest })
        .from(gameVersions)
        .where(and(eq(gameVersions.buildHash, buildHash), eq(gameVersions.status, "ready")))
        .limit(1);
      if (version?.manifest.mode !== "enforced") throw new Error("Unknown build");
      const rows = await db
        .select({ path: versionFiles.path, sha256: versionFiles.sha256 })
        .from(versionFiles)
        .where(eq(versionFiles.versionId, version.id));
      const files = Object.fromEntries(rows.map((row) => [row.path, row.sha256]));
      const digest = files[version.manifest.entry];
      const bytes = digest === undefined ? null : await blobs.get(blobKey(digest));
      if (bytes === null) throw new Error("Missing bundle");
      const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { entry: version.manifest.entry, files, source };
    },
  };
}

/** Creates and disposes a throwaway match per seat count; any failure fails that count. */
export function createRulesSetupChecker(
  host: Pick<RulesHostClient, "load" | "create" | "dispose">,
  builds: VersionBuildStore,
): SetupChecker {
  let next = 0;
  return {
    async check(build, seatCounts, options) {
      const { buildHash, ...hostBuild } = build;
      return builds.staged(buildHash, hostBuild, async () => {
        try {
          await host.load(buildHash);
        } catch {
          return seatCounts;
        }
        const failed: number[] = [];
        for (const count of seatCounts) {
          const matchId = `finalize-check-${buildHash.slice(0, 16)}-${count}-${++next}`;
          const seats = Array.from({ length: count }, (_, seat) => String(seat));
          try {
            await host.create(matchId, { buildHash, seats, seed: 1, options });
          } catch {
            failed.push(count);
          } finally {
            host.dispose(matchId);
          }
        }
        return failed;
      });
    },
  };
}
