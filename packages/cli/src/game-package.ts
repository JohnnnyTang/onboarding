import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ComponentsFile,
  ComponentsFileSchema,
  type Manifest,
  ManifestSchema,
  type ValidationError,
} from "@bgp/schema";

/** The manifest file at the root of every game package (manifest.md). */
export const MANIFEST_FILE = "bgp.json";
/** Where `bgp build` looks for the game's source entry, relative to the package. */
export const SOURCE_ENTRY = "src/index.ts";

/** A problem the developer must fix, reported with the file or field it concerns. */
export class PackageError extends Error {
  readonly errors: readonly ValidationError[];
  constructor(message: string, errors: readonly ValidationError[] = []) {
    super(message);
    this.name = "PackageError";
    this.errors = errors;
  }
}

export interface GamePackage {
  /** Absolute path of the package root. */
  dir: string;
  manifest: Manifest;
  components: ComponentsFile;
}

function issuesAt(file: string, issues: readonly { path: PropertyKey[]; message: string }[]) {
  return issues.map((issue) => ({
    path: [file, ...issue.path.map(String)].join("."),
    message: issue.message,
  }));
}

async function readJson(dir: string, file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(join(dir, file), "utf8");
  } catch {
    throw new PackageError(`Cannot read ${file} in ${dir}`, [
      { path: file, message: "File not found" },
    ]);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new PackageError(`${file} is not valid JSON`, [{ path: file, message: "Invalid JSON" }]);
  }
}

/** Reads and parses `bgp.json` and the components file it names. */
export async function loadGamePackage(dir: string): Promise<GamePackage> {
  const manifest = ManifestSchema.safeParse(await readJson(dir, MANIFEST_FILE));
  if (!manifest.success) {
    throw new PackageError(
      `${MANIFEST_FILE} does not match the manifest contract`,
      issuesAt(MANIFEST_FILE, manifest.error.issues),
    );
  }
  const file = manifest.data.components;
  const components = ComponentsFileSchema.safeParse(await readJson(dir, file));
  if (!components.success) {
    throw new PackageError(
      `${file} does not match the components contract`,
      issuesAt(file, components.error.issues),
    );
  }
  return { dir, manifest: manifest.data, components: components.data };
}
