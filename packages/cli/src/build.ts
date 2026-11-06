import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findModuleImports, MAX_BUNDLE_BYTES, type ValidationError } from "@bgp/schema";
import { type BuildOptions, build, type Message, type Plugin } from "esbuild";
import { type GamePackage, PackageError, SOURCE_ENTRY } from "./game-package.js";

/** The one package game code may import at run time (architecture.md, package boundaries). */
const SDK_PACKAGE = "@bgp/rules";
/** Game code may import this package for types only; esbuild drops type-only imports. */
const TYPES_PACKAGE = "@bgp/schema";

/**
 * The CLI's own directory. Game code resolves `@bgp/rules` from here, so a bundle always
 * contains the SDK that `bgp validate` checks it against, and a game package outside the
 * workspace needs no installed copy.
 */
const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Files of the game itself, as opposed to the SDK and its dependencies. */
function isGameFile(path: string, dir: string): boolean {
  return isInside(path, dir) && !path.includes(`${sep}node_modules${sep}`);
}

/**
 * Enforces the games/* import rule while bundling: relative imports must stay inside the
 * package, `@bgp/rules` resolves to the CLI's copy, and anything else fails the build.
 */
export function importPolicy(gameDir: string): Plugin {
  return {
    name: "bgp-import-policy",
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind === "entry-point" || !isGameFile(args.importer, gameDir)) return undefined;
        if (args.path.startsWith(".") || isAbsolute(args.path)) {
          if (isInside(resolve(args.resolveDir, args.path), gameDir)) return undefined;
          return { errors: [{ text: `Game code may not import files outside the package` }] };
        }
        if (args.path === SDK_PACKAGE) {
          const found = await builder.resolve(SDK_PACKAGE, {
            kind: args.kind,
            resolveDir: CLI_DIR,
          });
          return found.errors.length > 0 ? { errors: found.errors } : { path: found.path };
        }
        const text =
          args.path === TYPES_PACKAGE
            ? `Import ${TYPES_PACKAGE} for types only ("import type"); runtime helpers come from ${SDK_PACKAGE}`
            : `Game code may import only ${SDK_PACKAGE} (and ${TYPES_PACKAGE} types), not "${args.path}"`;
        return { errors: [{ text }] };
      });
    },
  };
}

/** esbuild settings for a game bundle: one ES module with no imports (architecture.md). */
export function bundleOptions(pkg: GamePackage): BuildOptions & { outfile: string } {
  if (pkg.manifest.mode !== "enforced") throw new Error("Only enforced games have a bundle");
  return {
    absWorkingDir: pkg.dir,
    entryPoints: [join(pkg.dir, SOURCE_ENTRY)],
    outfile: join(pkg.dir, pkg.manifest.entry),
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    charset: "ascii",
    legalComments: "none",
    logLevel: "silent",
    metafile: true,
    write: false,
    plugins: [importPolicy(pkg.dir)],
  };
}

export function formatMessage(message: Message): string {
  const at = message.location
    ? `${message.location.file}:${message.location.line}:${message.location.column + 1}: `
    : "";
  return `${at}${message.text}`;
}

/** Shape checks on the emitted bundle, the same ones finalize applies on upload. */
export function checkBundle(entry: string, source: string): ValidationError[] {
  const errors: ValidationError[] = [];
  if (Buffer.byteLength(source) > MAX_BUNDLE_BYTES) {
    errors.push({ path: entry, message: "The game bundle may be at most 2 MB" });
  }
  for (const message of findModuleImports(source)) errors.push({ path: entry, message });
  return errors;
}

export interface BuiltGame {
  /** Path of the bundle relative to the package (the manifest's `entry`). */
  entry: string;
  source: string;
  bytes: number;
}

/** Turns an esbuild result into the bundle text, or throws with every error found. */
export function bundleFrom(
  pkg: GamePackage,
  outputFiles: readonly { path: string; text: string }[] | undefined,
): BuiltGame {
  if (pkg.manifest.mode !== "enforced") throw new Error("Only enforced games have a bundle");
  const entry = pkg.manifest.entry;
  const source = outputFiles?.find((file) => file.path.endsWith(".js"))?.text;
  if (source === undefined) throw new PackageError("esbuild produced no bundle");
  const errors = checkBundle(entry, source);
  if (errors.length > 0) throw new PackageError("The bundle is not a valid game bundle", errors);
  return { entry, source, bytes: Buffer.byteLength(source) };
}

/** Bundles the game without writing it. Build errors become a PackageError. */
export async function bundleGame(pkg: GamePackage): Promise<BuiltGame> {
  const options = bundleOptions(pkg);
  try {
    const result = await build(options);
    return bundleFrom(pkg, result.outputFiles);
  } catch (error) {
    if (error instanceof PackageError) throw error;
    const messages = (error as { errors?: Message[] }).errors;
    if (!Array.isArray(messages)) throw error;
    throw new PackageError(
      "The game does not build",
      messages.map((message) => ({ path: SOURCE_ENTRY, message: formatMessage(message) })),
    );
  }
}

/** `bgp build`: bundles the game and writes it to the manifest's `entry`. */
export async function buildGame(pkg: GamePackage): Promise<BuiltGame> {
  const built = await bundleGame(pkg);
  const target = join(pkg.dir, built.entry);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, built.source);
  return built;
}
