import { readdir, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export function slash(path: string): string {
  return path.split(sep).join("/");
}

export function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !path.startsWith("/") && !path.includes(":"));
}

export async function filesUnder(
  directory: string,
  skip: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const files: string[] = [];
  const visited = new Set<string>();
  async function visit(path: string): Promise<void> {
    const canonical = await realpath(path);
    if (visited.has(canonical)) return;
    visited.add(canonical);
    const info = await stat(path);
    if (info.isDirectory()) {
      for (const entry of await readdir(path)) {
        if (!skip.has(entry)) await visit(join(path, entry));
      }
    } else if (info.isFile()) {
      files.push(path);
    }
  }
  await visit(directory);
  return files.sort();
}
