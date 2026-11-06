import { createHash } from "node:crypto";
import {
  type ComponentsFile,
  ComponentsFileSchema,
  type HostBuild,
  HostBuildSchema,
  MAX_HOST_SOURCE_BYTES,
  Sha256Schema,
} from "@bgp/schema";
import { GameError } from "./errors.js";

/** T10 supplies finalized immutable version files; no game code executes here. */
export interface BuildStore {
  load(buildHash: string): Promise<HostBuild>;
}

/**
 * What a host process runs for one build: an enforced game's bundle, or the built-in sandbox
 * definition over a sandbox version's components file (trusted platform code, T17).
 */
export type HostGame =
  | { kind: "bundle"; source: string }
  | { kind: "sandbox"; components: ComponentsFile };

/** Verifies a build against its hash before anything reaches a host process. */
export async function loadBuild(store: BuildStore, buildHash: string): Promise<HostGame> {
  try {
    Sha256Schema.parse(buildHash);
    const build = HostBuildSchema.parse(await store.load(buildHash));
    const digest = (source: string) => createHash("sha256").update(source).digest("hex");
    const index = Object.keys(build.files)
      .sort()
      .map((path) => `${path}\t${build.files[path]}\n`)
      .join("");
    const path = "mode" in build ? build.components : build.entry;
    if (
      digest(index) !== buildHash ||
      digest(build.source) !== build.files[path] ||
      Buffer.byteLength(build.source) > MAX_HOST_SOURCE_BYTES
    )
      throw new GameError();
    if (!("mode" in build)) return { kind: "bundle", source: build.source };
    const components = ComponentsFileSchema.parse(JSON.parse(build.source));
    if (!components.zones || !components.setup) throw new GameError();
    return { kind: "sandbox", components };
  } catch {
    throw new GameError();
  }
}
