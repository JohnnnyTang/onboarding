import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { contractJsonSchemas } from "../packages/schema/src/json-schema.js";

const output = fileURLToPath(new URL("../packages/schema/json/", import.meta.url));
await mkdir(output, { recursive: true });
const written = new Set<string>();
for (const [name, document] of Object.entries(contractJsonSchemas())) {
  const filename = `${name.replace(/Schema$/, "").replace(/[A-Z]/g, (letter, offset: number) => `${offset ? "-" : ""}${letter.toLowerCase()}`)}.json`;
  const content = `${JSON.stringify(document, null, 2)}\n`;
  let previous: string | undefined;
  try {
    previous = await readFile(`${output}/${filename}`, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (previous !== content) await writeFile(`${output}/${filename}`, content);
  written.add(filename);
}
for (const file of await readdir(output)) {
  if (file.endsWith(".json") && !written.has(file)) await unlink(`${output}/${file}`);
}
console.info(`Exported ${written.size} contract schemas to packages/schema/json/.`);
