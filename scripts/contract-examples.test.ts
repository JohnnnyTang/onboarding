import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import * as contracts from "../packages/schema/src/index.js";

function checkReferences(document: unknown, node: unknown = document): void {
  if (!node || typeof node !== "object") return;
  if ("$ref" in node && typeof node.$ref === "string") {
    expect(node.$ref.startsWith("#/"), "Generated references must be local").toBe(true);
    let target: unknown = document;
    for (const encoded of node.$ref.slice(2).split("/")) {
      const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!target || typeof target !== "object" || !Object.hasOwn(target, key)) {
        throw new Error(`Unresolved JSON Schema reference ${node.$ref}`);
      }
      target = Object.entries(target).find(([name]) => name === key)?.[1];
    }
  }
  for (const value of Object.values(node)) checkReferences(document, value);
}

const directory = new URL("../docs/contracts/", import.meta.url);
for (const file of (await readdir(directory)).filter((file) => file.endsWith(".md"))) {
  const source = await readFile(new URL(file, directory), "utf8");
  for (const [index, block] of [...source.matchAll(/```json\r?\n([\s\S]*?)```/g)].entries()) {
    test(`${file} JSON example ${index + 1} parses against its documented contract`, () => {
      const annotation = source.slice(0, block.index).match(/<!-- schema: (\w+) -->\s*$/)?.[1];
      expect(annotation, "JSON examples must name their schema").toBeDefined();
      const schema: unknown = Object.entries(contracts).find(([name]) => name === annotation)?.[1];
      if (
        !schema ||
        typeof schema !== "object" ||
        !("parse" in schema) ||
        typeof schema.parse !== "function"
      ) {
        throw new Error(`Missing schema ${annotation}`);
      }
      schema.parse(JSON.parse(block[1] ?? ""));
    });
  }
}

test("documented wire error codes and HTTP endpoints match the schema registries", async () => {
  const protocol = await readFile(new URL("protocol.md", directory), "utf8");
  const codes = [...protocol.matchAll(/^\| `([A-Z_]+)`\s*\|/gm)].map((match) => match[1]);
  expect([...contracts.ErrorCodeSchema.options].sort()).toEqual(codes.sort());
  const http = await readFile(new URL("http-api.md", directory), "utf8");
  const routes = [...http.matchAll(/^\| `(GET|POST|PUT|PATCH) (\/api\/[^`]+)`/gm)].map(
    (match) => `${match[1]} ${match[2]}`,
  );
  expect(Object.keys(contracts.HTTP_CONTRACTS).sort()).toEqual(routes.sort());
});

test("committed JSON Schemas match the Zod definitions with no missing or stale files", async () => {
  const output = new URL("../packages/schema/json/", import.meta.url);
  const expected: string[] = [];
  for (const [name, document] of Object.entries(contracts.contractJsonSchemas())) {
    checkReferences(document);
    const filename = `${name.replace(/Schema$/, "").replace(/[A-Z]/g, (letter, offset: number) => `${offset ? "-" : ""}${letter.toLowerCase()}`)}.json`;
    expected.push(filename);
    expect(JSON.parse(await readFile(new URL(filename, output), "utf8")), filename).toEqual(
      document,
    );
  }
  expect(
    (await readdir(fileURLToPath(output))).filter((file) => file.endsWith(".json")).sort(),
  ).toEqual(expected.sort());
});
