import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { checkSource } from "./check-boundaries.js";

const root = process.cwd();
const check = (file: string, source: string) => checkSource(root, resolve(root, file), source);

describe("package boundaries", () => {
  test("database dependencies stay in the server and tooling stays in config files", () => {
    for (const source of ['import "drizzle-orm";', 'import "postgres";']) {
      expect(check("apps/server/src/db/connection.ts", source)).toEqual([]);
      expect(check("packages/rules/src/index.ts", source)).not.toEqual([]);
      expect(check("apps/web/src/index.ts", source)).not.toEqual([]);
    }
    expect(check("apps/server/drizzle.config.ts", 'import "drizzle-kit";')).toEqual([]);
    expect(check("apps/server/vitest.config.ts", 'import "vitest/config";')).toEqual([]);
    expect(check("apps/server/src/index.ts", 'import "drizzle-kit";')).not.toEqual([]);
    expect(check("apps/server/src/index.ts", 'import "vitest/config";')).not.toEqual([]);
    for (const config of ["apps/web/vite.config.ts", "apps/web/vitest.config.ts"]) {
      expect(check(config, 'import react from "@vitejs/plugin-react";')).toEqual([]);
    }
    expect(check("apps/web/vite.config.ts", 'import "vite";')).toEqual([]);
    expect(check("apps/web/src/main.tsx", 'import "vite";')).not.toEqual([]);
    expect(check("apps/web/src/main.tsx", 'import "@vitejs/plugin-react";')).not.toEqual([]);
    // Build configs run in Node; the app itself may not use Node built-ins.
    expect(check("apps/web/vite.config.ts", 'import { createHash } from "node:crypto";')).toEqual(
      [],
    );
    expect(check("apps/web/src/main.tsx", 'import "node:crypto";')).not.toEqual([]);
    // Only web unit tests may use the in-memory IndexedDB.
    expect(check("apps/web/src/projects/store.test.ts", 'import "fake-indexeddb/auto";')).toEqual(
      [],
    );
    expect(check("apps/web/src/main.tsx", 'import "fake-indexeddb/auto";')).not.toEqual([]);
    expect(check("apps/web/src/main.tsx", 'import { openDB } from "idb";')).toEqual([]);
    expect(check("apps/web/src/cards/csv.ts", 'import Papa from "papaparse";')).toEqual([]);
    expect(check("packages/card-generator/src/x.ts", 'import Papa from "papaparse";')).not.toEqual(
      [],
    );
  });

  test("the web app admits its UI libraries but no game package", () => {
    const source = [
      'import { createRoot } from "react-dom/client";',
      'import { Link } from "react-router";',
      'import { useQuery } from "@tanstack/react-query";',
      'import { UserManager } from "oidc-client-ts";',
    ].join("\n");
    expect(check("apps/web/src/main.tsx", source)).toEqual([]);
    expect(check("apps/web/src/main.tsx", 'import game from "harbor-market";')).not.toEqual([]);
    expect(check("packages/table-2d/src/index.ts", 'import "react";')).not.toEqual([]);
  });
  test("admits public imports and same-package relative imports", () => {
    expect(
      check(
        "packages/rules/src/index.ts",
        'import type { Json } from "@bgp/schema"; import "./helper.js";',
      ),
    ).toEqual([]);
    expect(
      check("apps/server/src/index.ts", 'import { readFile } from "node:fs/promises";'),
    ).toEqual([]);
    expect(
      check("games/harbor-market/src/index.ts", 'import { type Json } from "@bgp/schema";'),
    ).toEqual([]);
  });

  test.each([
    'import "pixi.js";',
    'export { x } from "@bgp/table-2d";',
    'const module = import("@bgp/table-2d");',
    'import x = require("@bgp/table-2d");',
    'type T = import("@bgp/table-2d").T;',
    'import "node:fs";',
    'import "fs/promises";',
    'import "../../../apps/server/src/index.js";',
    "const module = import(moduleName);",
  ])("rejects a rules import bypass: %s", (source) => {
    expect(check("packages/rules/src/index.ts", source)).not.toEqual([]);
  });

  test("games may use schema types but cannot evaluate its validators", () => {
    expect(
      check("games/harbor-market/src/index.ts", 'import { schema } from "@bgp/schema";'),
    ).not.toEqual([]);
    expect(check("games/harbor-market/src/index.ts", 'import "react";')).not.toEqual([]);
  });

  test("only web worker entry points may import the rules runtime", () => {
    const source = 'import "@bgp/rules";';
    expect(check("apps/web/src/index.ts", source)).not.toEqual([]);
    expect(check("apps/web/src/workers/game.ts", source)).toEqual([]);
    expect(check("apps/web/src/game.worker.ts", source)).toEqual([]);
  });

  test("only the game module loader may import a computed URL", () => {
    const source = "const module = await import(url);";
    expect(check("apps/web/src/workers/game-module.ts", source)).toEqual([]);
    expect(check("apps/web/src/workers/game-worker.ts", source)).not.toEqual([]);
    expect(check("apps/web/src/match/match-page.tsx", source)).not.toEqual([]);
  });

  test("the rules host may import SDK types but evaluates rules only inside its sandbox", () => {
    expect(
      check("packages/rules-host/src/index.ts", 'import type { MatchState } from "@bgp/rules";'),
    ).toEqual([]);
    expect(
      check("packages/rules-host/src/index.ts", 'import { createMatch } from "@bgp/rules";'),
    ).not.toEqual([]);
  });

  test.each([
    "Date.now();",
    "Math.random();",
    'Math["random"]();',
    "fetch(url);",
    "setTimeout(fn, 0);",
    "process.env;",
    "globalThis.fetch(url);",
  ])("rejects impure runtime access: %s", (source) => {
    expect(check("packages/rules/src/index.ts", source)).not.toEqual([]);
  });

  test("test imports do not grant production code access to test tools", () => {
    const source = 'import { test } from "vitest";';
    expect(check("packages/rules/src/index.test.ts", source)).toEqual([]);
    expect(check("packages/rules/src/index.ts", source)).not.toEqual([]);
    expect(check("packages/rules/src/index.test.ts", 'import "pixi.js";')).not.toEqual([]);
  });

  test("only the hash adapter may use Web Crypto subtle; entropy stays forbidden", () => {
    expect(check("packages/rules/src/hash.ts", 'crypto.subtle.digest("SHA-256", bytes);')).toEqual(
      [],
    );
    expect(
      check("packages/rules/src/index.ts", 'crypto.subtle.digest("SHA-256", bytes);'),
    ).not.toEqual([]);
    expect(check("packages/rules/src/hash.ts", "crypto.getRandomValues(bytes);")).not.toEqual([]);
    expect(check("packages/rules/src/hash.ts", "crypto.subtle.generateKey(options);")).not.toEqual(
      [],
    );
    expect(
      check("packages/rules/src/hash.ts", 'crypto.subtle.digest("SHA-1", bytes);'),
    ).not.toEqual([]);
    expect(check("packages/rules/src/hash.ts", "const capability = crypto.subtle;")).not.toEqual(
      [],
    );
    expect(check("packages/rules/src/hash.ts", "Math.random();")).not.toEqual([]);
    expect(check("packages/rules/src/index.ts", 'import { produce } from "immer";')).toEqual([]);
  });

  test("data property names are not confused with globals", () => {
    expect(
      check("packages/schema/src/index.ts", 'const data = { process: "value" }; data.process;'),
    ).toEqual([]);
  });
});

test("game tests may use the public harness and validators without widening game imports", () => {
  for (const source of [
    'import { runMatch } from "@bgp/testing";',
    'import { TableSnapshotSchema } from "@bgp/schema";',
  ]) {
    expect(check("games/harbor-market/test/game.test.ts", source)).toEqual([]);
    expect(check("games/harbor-market/src/index.ts", source)).not.toEqual([]);
  }
  expect(check("games/harbor-market/test/game.test.ts", 'import "@bgp/table-2d";')).not.toEqual([]);
});
