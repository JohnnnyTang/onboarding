import { createHash } from "node:crypto";
import { type HostBuild, HostBuildSchema, Sha256Schema } from "@bgp/schema";
import { GameError } from "./errors.js";

/** T10 supplies finalized immutable version files; no game code executes here. */
export interface BuildStore {
  load(buildHash: string): Promise<HostBuild>;
}

export async function loadBuild(store: BuildStore, buildHash: string): Promise<string> {
  try {
    Sha256Schema.parse(buildHash);
    const build = HostBuildSchema.parse(await store.load(buildHash));
    const digest = (source: string) => createHash("sha256").update(source).digest("hex");
    const index = Object.keys(build.files)
      .sort()
      .map((path) => `${path}\t${build.files[path]}\n`)
      .join("");
    if (
      digest(index) !== buildHash ||
      digest(build.source) !== build.files[build.entry] ||
      Buffer.byteLength(build.source) > 2 * 1024 * 1024
    )
      throw new GameError();
    return build.source;
  } catch {
    throw new GameError();
  }
}
