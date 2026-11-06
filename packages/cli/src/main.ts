import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ValidationError } from "@bgp/schema";
import { buildGame } from "./build.js";
import { DEFAULT_DEV_PORT, DEFAULT_WEB_ORIGIN, startDevServer } from "./dev.js";
import { loadGamePackage, PackageError } from "./game-package.js";
import { initGame } from "./init.js";
import { DEFAULT_VALIDATE_OPTIONS, validateGame } from "./validate.js";

/** Where the CLI writes; tests capture it. */
export interface Output {
  out(line: string): void;
  err(line: string): void;
}

export const USAGE = `Usage: bgp <command> [options]

Commands:
  init <dir>       Create a new game package from the starter template
  dev [dir]        Serve the game to the web app's hot-seat table; reload on every change
  build [dir]      Bundle the game into the manifest's entry (one ES module, no imports)
  validate [dir]   Check the package, the bundle, determinism and hidden information
  help             Show this help

Run "bgp <command> --help" for a command's options. [dir] defaults to the current directory.`;

const VALIDATE_USAGE = `Usage: bgp validate [dir] [--games <n>] [--seed <n>] [--max-moves <n>]

Builds the game in memory and checks everything finalize checks, then plays random games
(the random bot picks from legalMoves) in a locked-down worker. Each game is replayed to
check determinism, and every seat's view and table are checked for leaked identities.

Options:
  --games <n>      Random games to play (default ${DEFAULT_VALIDATE_OPTIONS.games})
  --seed <n>       Seed of the first game (default ${DEFAULT_VALIDATE_OPTIONS.firstSeed})
  --max-moves <n>  Moves per game before it stops with a warning (default ${DEFAULT_VALIDATE_OPTIONS.maxMoves})`;

const BUILD_USAGE = `Usage: bgp build [dir]

Bundles src/index.ts with esbuild into the manifest's entry: one ES module with no imports.
Game code may import only @bgp/rules (and @bgp/schema types).`;

const INIT_USAGE = `Usage: bgp init <dir> [--id <slug>] [--name <name>]

Writes a starter game package (a small, complete card game) into an empty directory.

Options:
  --id <slug>      Game id (default: from the directory name)
  --name <name>    Display name (default: from the id)`;

const DEV_USAGE = `Usage: bgp dev [dir] [--port <n>] [--web <origin>]

Rebuilds the game on every change in the package and serves it to the web app's hot-seat
page, which reloads it and replays the current game. Open the printed link; stop with Ctrl+C.

Options:
  --port <n>       Port on 127.0.0.1 (default ${DEFAULT_DEV_PORT}; 0 picks a free one)
  --web <origin>   The web app (default ${DEFAULT_WEB_ORIGIN})`;

/** A usage error: wrong arguments. Exit code 2. */
class UsageError extends Error {}

function integer(name: string, value: string | undefined, fallback: number, min: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new UsageError(`--${name} must be an integer of at least ${min}`);
  }
  return parsed;
}

function printErrors(output: Output, errors: readonly ValidationError[]): void {
  for (const error of errors) {
    output.err(error.path ? `  ${error.path}: ${error.message}` : `  ${error.message}`);
  }
}

function packageDir(positionals: readonly string[]): string {
  if (positionals.length > 1) throw new UsageError("Expected at most one directory");
  return resolve(positionals[0] ?? ".");
}

async function initCommand(args: string[], output: Output): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      id: { type: "string" },
      name: { type: "string" },
    },
  });
  if (values.help) {
    output.out(INIT_USAGE);
    return 0;
  }
  const [target, ...rest] = positionals;
  if (target === undefined || rest.length > 0) throw new UsageError("Expected one directory");
  const created = await initGame(target, {
    ...(values.id === undefined ? {} : { id: values.id }),
    ...(values.name === undefined ? {} : { name: values.name }),
  });
  output.out(`Created ${created.name} (${created.id}) in ${created.dir}`);
  output.out("Next: bgp dev (hot-seat table), bgp validate, then bgp publish.");
  return 0;
}

function origin(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`--${name} must be an absolute URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError(`--${name} must use http or https`);
  }
  return url.origin;
}

/** Resolves when the process is asked to stop. */
function interrupted(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
}

async function devCommand(args: string[], output: Output): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      port: { type: "string" },
      web: { type: "string" },
    },
  });
  if (values.help) {
    output.out(DEV_USAGE);
    return 0;
  }
  const port = integer("port", values.port, DEFAULT_DEV_PORT, 0);
  if (port > 65535) throw new UsageError("--port must be at most 65535");
  const webOrigin = origin("web", values.web ?? DEFAULT_WEB_ORIGIN);
  const server = await startDevServer(packageDir(positionals), {
    port,
    webOrigin,
    onBuild(game) {
      if (game.errors.length === 0) {
        output.out(`Build ${game.buildId}: ${game.manifest.id} is ready`);
      } else {
        output.err(`Build ${game.buildId} failed:`);
        printErrors(output, game.errors);
      }
    },
  });
  output.out(`Serving on ${server.origin}`);
  output.out(`Open the hot-seat table: ${server.pageUrl}`);
  await interrupted();
  await server.close();
  return 0;
}

async function buildCommand(args: string[], output: Output): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" } },
  });
  if (values.help) {
    output.out(BUILD_USAGE);
    return 0;
  }
  const pkg = await loadGamePackage(packageDir(positionals));
  if (pkg.manifest.mode !== "enforced") {
    output.out("Sandbox games have no code to bundle; bgp publish uploads the components file.");
    return 0;
  }
  const built = await buildGame(pkg);
  output.out(`Built ${built.entry} (${(built.bytes / 1024).toFixed(1)} KiB)`);
  return 0;
}

async function validateCommand(args: string[], output: Output): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      games: { type: "string" },
      seed: { type: "string" },
      "max-moves": { type: "string" },
    },
  });
  if (values.help) {
    output.out(VALIDATE_USAGE);
    return 0;
  }
  const defaults = DEFAULT_VALIDATE_OPTIONS;
  const options = {
    ...defaults,
    games: integer("games", values.games, defaults.games, 1),
    firstSeed: integer("seed", values.seed, defaults.firstSeed, 0),
    maxMoves: integer("max-moves", values["max-moves"], defaults.maxMoves, 1),
  };
  if (options.firstSeed > 0xffff_ffff) throw new UsageError("--seed must fit in 32 bits");
  const pkg = await loadGamePackage(packageDir(positionals));
  output.out(`Validating ${pkg.manifest.id} ${pkg.manifest.version} (${pkg.manifest.mode})`);
  const result = await validateGame(pkg, options);
  if (result.packageErrors.length > 0) {
    output.err("Package errors:");
    printErrors(output, result.packageErrors);
  }
  if (result.gameErrors.length > 0) {
    output.err("Game errors:");
    for (const error of result.gameErrors) output.err(`  ${error}`);
  }
  for (const warning of result.warnings) output.out(`Warning: ${warning}`);
  if (result.runs.length > 0) {
    const moves = result.runs.reduce((sum, run) => sum + run.moves, 0);
    const finished = result.runs.filter((run) => run.stop === "finished").length;
    const played = `Played ${result.runs.length} random games (${moves} moves, ${finished} finished)`;
    output.out(
      result.ok ? `${played}: replays matched and no seat saw what it may not know.` : `${played}.`,
    );
  }
  if (!result.ok) {
    output.err("Validation failed.");
    return 1;
  }
  output.out("Validation passed.");
  return 0;
}

const COMMANDS: Record<string, (args: string[], output: Output) => Promise<number>> = {
  init: initCommand,
  dev: devCommand,
  build: buildCommand,
  validate: validateCommand,
};

/** Runs one CLI invocation and returns its exit code. */
export async function main(argv: readonly string[], output: Output): Promise<number> {
  const [command, ...args] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    output.out(USAGE);
    return command === undefined ? 2 : 0;
  }
  const run = COMMANDS[command];
  if (!run) {
    output.err(`Unknown command "${command}".\n\n${USAGE}`);
    return 2;
  }
  try {
    return await run(args, output);
  } catch (error) {
    if (error instanceof PackageError) {
      output.err(error.message);
      printErrors(output, error.errors);
      return 1;
    }
    if (
      error instanceof UsageError ||
      (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")
    ) {
      output.err(`${(error as Error).message}\n\nRun "bgp ${command} --help" for usage.`);
      return 2;
    }
    throw error;
  }
}
