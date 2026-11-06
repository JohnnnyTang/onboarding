import { cp, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SlugSchema } from "@bgp/schema";
import { cardBack, cardFront } from "./card-art.js";
import { PackageError } from "./game-package.js";

/** The starter package, next to src/ and dist/ in this package. */
const TEMPLATE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "template");
/** Files whose placeholders are filled in. */
const FILLED = ["bgp.json", "package.json", "README.md"];
const CARD_VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export interface InitOptions {
  /** The game's slug; defaults to one derived from the directory name. */
  id?: string;
  /** Display name; defaults to one derived from the id. */
  name?: string;
}

export interface InitResult {
  dir: string;
  id: string;
  name: string;
}

/** A slug from a directory name: lowercase letters, digits and single dashes. */
export function slugFrom(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function titleFrom(id: string): string {
  return id
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

async function isEmptyOrMissing(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return true;
    throw error;
  }
}

/** `bgp init`: writes the starter game package into `dir`, which must be empty or absent. */
export async function initGame(target: string, options: InitOptions = {}): Promise<InitResult> {
  const dir = resolve(target);
  const id = options.id ?? slugFrom(basename(dir));
  if (!SlugSchema.safeParse(id).success) {
    throw new PackageError(`"${id}" is not a valid game id`, [
      {
        path: "id",
        message:
          "3-48 characters: lowercase letters, digits and dashes, starting with a letter or digit",
      },
    ]);
  }
  const name = (options.name ?? titleFrom(id)).trim();
  if (name.length < 1 || name.length > 80) {
    throw new PackageError("The game name must have 1-80 characters");
  }
  if (!(await isEmptyOrMissing(dir))) {
    throw new PackageError(
      `${dir} is not empty; bgp init writes a new package into an empty directory`,
    );
  }
  await mkdir(dir, { recursive: true });
  await cp(TEMPLATE_DIR, dir, { recursive: true });
  await rename(join(dir, "gitignore"), join(dir, ".gitignore"));
  for (const file of FILLED) {
    const path = join(dir, file);
    const text = await readFile(path, "utf8");
    // JSON.stringify(...).slice(1, -1) escapes the name for the JSON files.
    const jsonName = JSON.stringify(name).slice(1, -1);
    await writeFile(
      path,
      text
        .replaceAll("%GAME_ID%", id)
        .replaceAll("%GAME_NAME%", file.endsWith(".json") ? jsonName : name),
    );
  }
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(join(dir, "assets", "card-back.png"), cardBack());
  for (const value of CARD_VALUES) {
    await writeFile(join(dir, "assets", `card-${value}.png`), cardFront(value));
  }
  return { dir, id, name };
}
