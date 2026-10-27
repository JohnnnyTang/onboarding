import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { checkWasmInventory } from "./check-wasm-inventory.js";
import { isInside } from "./files.js";

const scratch = resolve(".scratch");
const fixtures: string[] = [];
const approved = {
  id: "quickjs",
  package: "quickjs-emscripten",
  decision: "D-002",
  scope: "server",
  reason: "Isolates game code",
  fallback: "Restricted Node process",
  files: ["packages/rules-host/dist/**/*.wasm", "node_modules/**/*.wasm"],
};

async function fixture(modules: unknown[] = []): Promise<string> {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "wasm-"));
  fixtures.push(root);
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "wasm-inventory.json"), JSON.stringify({ schemaVersion: 1, modules }));
  await writeFile(
    join(root, "docs/decisions.md"),
    "## D-002 WASM\n| Use | Library |\n| Sandbox | quickjs-emscripten |\n## D-003 Runtime\n",
  );
  return root;
}

async function binary(root: string, path: string): Promise<string> {
  const file = join(root, path);
  await mkdir(resolve(file, ".."), { recursive: true });
  await writeFile(file, new Uint8Array([0, 97, 115, 109]));
  return file;
}

afterEach(async () => {
  for (const root of fixtures.splice(0)) {
    if (!isInside(scratch, root) || root === scratch)
      throw new Error("Unsafe test fixture cleanup.");
    await rm(root, { recursive: true, force: true });
  }
});

describe("WASM inventory", () => {
  test("an empty scaffold passes", async () => {
    const root = await fixture();
    expect(await checkWasmInventory(root, [{ path: root }])).toEqual({ errors: [], files: [] });
  });

  test("an unlisted binary planted in a build output fails", async () => {
    const root = await fixture();
    await binary(root, "packages/rules/dist/planted.wasm");
    const result = await checkWasmInventory(root, []);
    expect(result.errors).toContain("Unlisted WASM file: packages/rules/dist/planted.wasm.");
    expect(result.files[0]?.bytes).toBe(4);
  });

  test("scans transitive production dependencies, excluding development-only binaries", async () => {
    const root = await fixture();
    await binary(root, "node_modules/prod/nested/kernel.wasm");
    await binary(root, "node_modules/dev/ignored.wasm");
    const result = await checkWasmInventory(root, [
      {
        path: root,
        dependencies: {
          parent: {
            path: join(root, "node_modules/prod"),
            dependencies: {
              nested: { path: join(root, "node_modules/prod/nested") },
            },
          },
        },
      },
    ]);
    expect(result.files).toHaveLength(1);
    expect(result.errors.join("\n")).toContain("kernel.wasm");
    expect(result.errors.join("\n")).not.toContain("ignored.wasm");
  });

  test("accepts an inventoried module with a D-002 entry", async () => {
    const root = await fixture([approved]);
    await binary(root, "packages/rules-host/dist/quickjs.wasm");
    expect((await checkWasmInventory(root, [])).errors).toEqual([]);
  });

  test("fails when the inventory module has no D-002 row", async () => {
    const root = await fixture([{ ...approved, package: "unreviewed-engine" }]);
    expect((await checkWasmInventory(root, [])).errors.join("\n")).toContain("no matching D-002");
  });

  test("server-only modules cannot be shipped in the web output", async () => {
    const root = await fixture([{ ...approved, files: ["apps/web/dist/**/*.wasm"] }]);
    await binary(root, "apps/web/dist/assets/quickjs.wasm");
    const result = await checkWasmInventory(root, []);
    expect(result.errors.join("\n")).toContain("Server-only WASM leaked");
    expect(result.errors.join("\n")).toContain("Phase 1 web output must not contain WASM");
  });

  test("fails closed on malformed inventory and failed dependency discovery", async () => {
    const root = await fixture([{ id: "missing-metadata" }]);
    expect((await checkWasmInventory(root, [])).errors).toHaveLength(1);
    await expect(checkWasmInventory(root, {})).rejects.toThrow("dependency listing");
    await writeFile(join(root, "wasm-inventory.json"), "{}");
    await expect(checkWasmInventory(root, [])).rejects.toThrow("Invalid WASM inventory");
  });
});
