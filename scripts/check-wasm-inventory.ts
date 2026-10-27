import { spawnSync } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { matchesGlob, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { filesUnder, slash } from "./files.js";

interface WasmModule {
  id: string;
  package: string;
  files: string[];
  reason: string;
  fallback: string;
  decision: "D-002";
  scope: "server" | "web";
}

export interface WasmCheck {
  errors: string[];
  files: { path: string; bytes: number }[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function moduleEntry(value: unknown): value is WasmModule {
  return (
    record(value) &&
    ["id", "package", "reason", "fallback"].every(
      (key) => typeof value[key] === "string" && value[key].length > 0,
    ) &&
    value.decision === "D-002" &&
    (value.scope === "server" || value.scope === "web") &&
    Array.isArray(value.files) &&
    value.files.length > 0 &&
    value.files.every((path: unknown) => typeof path === "string" && path.length > 0)
  );
}

function dependencyPaths(tree: unknown): string[] {
  if (
    !Array.isArray(tree) ||
    tree.some((item: unknown) => !record(item) || typeof item.path !== "string")
  ) {
    throw new Error("pnpm production dependency listing must be an array of workspace records.");
  }
  const paths = new Set<string>();
  function collect(node: unknown): void {
    if (!record(node)) throw new Error("Malformed production dependency record.");
    if (typeof node.path !== "string")
      throw new Error("Production dependency has no installed path.");
    paths.add(node.path);
    for (const key of ["dependencies", "optionalDependencies"]) {
      const children = node[key];
      if (children !== undefined && !record(children)) throw new Error(`Malformed ${key} listing.`);
      if (record(children)) for (const child of Object.values(children)) collect(child);
    }
  }
  for (const workspace of tree) {
    if (!record(workspace)) continue;
    for (const key of ["dependencies", "optionalDependencies"]) {
      const children = workspace[key];
      if (children !== undefined && !record(children)) throw new Error(`Malformed ${key} listing.`);
      if (record(children)) for (const child of Object.values(children)) collect(child);
    }
  }
  return [...paths];
}

export async function checkWasmInventory(
  root: string,
  productionTree: unknown,
): Promise<WasmCheck> {
  const errors: string[] = [];
  const inventory: unknown = JSON.parse(
    await readFile(resolve(root, "wasm-inventory.json"), "utf8"),
  );
  if (!record(inventory) || inventory.schemaVersion !== 1 || !Array.isArray(inventory.modules)) {
    throw new Error("Invalid WASM inventory: expected schemaVersion 1 and a modules array.");
  }
  const modules: WasmModule[] = [];
  const decisions = await readFile(resolve(root, "docs/decisions.md"), "utf8");
  const decision = decisions.split("## D-002 ")[1]?.split(/^## D-/m)[0] ?? "";
  const inventoryRows = decision.split("\n").filter((line) => line.startsWith("|"));
  for (const entry of inventory.modules as unknown[]) {
    if (!moduleEntry(entry)) {
      errors.push(
        "Invalid WASM module: id, package, files, reason, fallback, scope and decision D-002 are required.",
      );
      continue;
    }
    if (modules.some((module) => module.id === entry.id))
      errors.push(`Duplicate WASM module id: ${entry.id}.`);
    if (!inventoryRows.some((row) => row.includes(entry.package))) {
      errors.push(`${entry.id}: package ${entry.package} has no matching D-002 inventory row.`);
    }
    modules.push(entry);
  }

  // Include all workspace outputs, including ignored/untracked files. Development-only
  // dependencies are excluded; installed production dependencies are traversed below.
  const skip = new Set([
    "node_modules",
    ".git",
    ".turbo",
    ".tools",
    ".scratch",
    "coverage",
    "playwright-report",
    "test-results",
  ]);
  const candidates = (await filesUnder(root, skip)).filter((file) =>
    file.toLowerCase().endsWith(".wasm"),
  );
  for (const path of dependencyPaths(productionTree)) {
    candidates.push(
      ...(await filesUnder(path, new Set(["node_modules"]))).filter((file) =>
        file.toLowerCase().endsWith(".wasm"),
      ),
    );
  }

  const found: WasmCheck["files"] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const path = slash(relative(root, candidate));
    const web = path.startsWith("apps/web/dist/");
    const canonical = await realpath(candidate);
    // A symlink into the web output still needs its own server-only check.
    if (seen.has(canonical) && !web) continue;
    seen.add(canonical);
    found.push({ path, bytes: (await stat(candidate)).size });
    const approved = modules.filter((module) =>
      module.files.some((pattern) => matchesGlob(path, pattern)),
    );
    if (approved.length === 0) errors.push(`Unlisted WASM file: ${path}.`);
    if (web) {
      // AC-14: no WASM may ship in the Phase 1 web app, regardless of inventory scope.
      errors.push(`Phase 1 web output must not contain WASM: ${path}.`);
      if (approved.some((module) => module.scope === "server"))
        errors.push(`Server-only WASM leaked into web output: ${path}.`);
    }
  }
  return { errors, files: found };
}

const root = fileURLToPath(new URL("../", import.meta.url));
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const pnpm = process.env.npm_execpath;
    if (!pnpm) throw new Error("Run this check through pnpm check:wasm.");
    const listing = spawnSync(
      process.execPath,
      [pnpm, "-r", "list", "--prod", "--depth", "Infinity", "--json"],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    if (listing.error) throw listing.error;
    if (listing.status !== 0)
      throw new Error(`Production dependency listing failed: ${listing.stderr}`);
    const result = await checkWasmInventory(root, JSON.parse(listing.stdout));
    for (const file of result.files) console.info(`${file.path}: ${file.bytes} bytes`);
    if (result.errors.length) {
      console.error(result.errors.join("\n"));
      process.exitCode = 1;
    } else console.info(`WASM inventory passed (${result.files.length} modules found).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
