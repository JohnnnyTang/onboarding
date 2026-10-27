import { describe, expect, test } from "vitest";
import {
  GamePackageSchema,
  ManifestSchema,
  optionsForManifestSchema,
  SlugSchema,
  VersionPathSchema,
} from "../src/index.js";
import { components, manifest } from "./fixtures.js";

describe("manifest and package validation", () => {
  test("accepts both modes and validates mode-dependent fields", () => {
    expect(ManifestSchema.parse(manifest)).toEqual(manifest);
    const { entry: _entry, ...sandbox } = manifest;
    const sandboxManifest = { ...sandbox, mode: "sandbox" };
    expect(GamePackageSchema.parse({ manifest: sandboxManifest, components })).toBeDefined();
    expect(ManifestSchema.safeParse({ ...manifest, mode: "sandbox" }).success).toBe(false);
    expect(ManifestSchema.safeParse(sandbox).success).toBe(false);
    expect(
      GamePackageSchema.safeParse({
        manifest: sandboxManifest,
        components: { schemaVersion: 1, defs: [] },
      }).success,
    ).toBe(false);
  });
  test.each(["UPPER", "ab", "bad_slug", "a".repeat(49), "-abc"])("rejects slug %s", (slug) => {
    expect(SlugSchema.safeParse(slug).success).toBe(false);
  });
  test.each(["../x", "/x", "a//x", "a/./x", "a/../x", "C:/x", "a\\x", "https://x/y"])(
    "rejects path %s",
    (path) => {
      expect(VersionPathSchema.safeParse(path).success).toBe(false);
    },
  );
  test.each(["1.0", "01.2.3", "1.2.3-01", "v1.2.3"])("rejects semver %s", (version) => {
    expect(ManifestSchema.safeParse({ ...manifest, version }).success).toBe(false);
  });
  test("validates option definitions and match option values", () => {
    const options = [
      { id: "short", label: "Short", type: "boolean", default: false },
      { id: "rounds", label: "Rounds", type: "integer", default: 5, min: 1, max: 10 },
      {
        id: "board",
        label: "Board",
        type: "choice",
        default: "small",
        choices: ["small", "large"],
      },
    ];
    const schema = optionsForManifestSchema(ManifestSchema.parse({ ...manifest, options }));
    expect(schema.parse({ short: true, rounds: 3, board: "large" })).toBeDefined();
    for (const bad of [
      { short: true, rounds: 0, board: "large" },
      { short: true, rounds: 3.5, board: "large" },
      { short: true, rounds: 3, board: "unknown" },
      { short: "false", rounds: 3, board: "small" },
      { short: true, rounds: 3, board: "small", extra: true },
      {},
    ]) {
      expect(schema.safeParse(bad).success).toBe(false);
    }
    expect(
      ManifestSchema.safeParse({ ...manifest, options: [...options, options[0]] }).success,
    ).toBe(false);
    expect(
      ManifestSchema.safeParse({ ...manifest, options: [{ ...options[1], default: 20 }] }).success,
    ).toBe(false);
    expect(ManifestSchema.safeParse({ ...manifest, players: { min: 4, max: 2 } }).success).toBe(
      false,
    );
    expect(ManifestSchema.safeParse({ ...manifest, players: { min: 1, max: 9 } }).success).toBe(
      false,
    );
  });
  test("reserved-looking option IDs cannot change the schema object's prototype", () => {
    const schema = optionsForManifestSchema(
      ManifestSchema.parse({
        ...manifest,
        options: [
          { id: "constructor", label: "Constructor", type: "boolean", default: false },
          { id: "__proto__", label: "Prototype", type: "boolean", default: false },
        ],
      }),
    );
    const input: unknown = JSON.parse('{"constructor":true,"__proto__":false}');
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse(input).success).toBe(true);
    expect(JSON.stringify(schema.parse(input))).toBe(JSON.stringify(input));
  });
});
