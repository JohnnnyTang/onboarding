import { describe, expect, test } from "vitest";
import {
  HotSeatMatchRecordSchema,
  LocalProjectSchema,
  ProjectAssetInfoSchema,
} from "../src/index.js";
import { components, manifest } from "./fixtures.js";

const { entry: _entry, ...base } = manifest;
const project = {
  id: "0192f3a4-5b6c-7d8e-9f01-23456789abcd",
  name: manifest.name,
  mode: "sandbox",
  manifest: { ...base, mode: "sandbox" },
  components,
  cardTemplates: [],
  csvSources: [],
  updatedAt: "2026-11-04T10:00:00.000Z",
  publishedVersionIds: [],
};

describe("local project records", () => {
  test("accept a sandbox project whose manifest and components form a package", () => {
    expect(LocalProjectSchema.parse(project)).toEqual(project);
  });

  test.each([
    ["an unknown field", { ...project, extra: 1 }],
    ["a blank name", { ...project, name: " " }],
    ["a manifest with another name", { ...project, name: "Other" }],
    ["an enforced manifest", { ...project, manifest: manifest }],
    ["components without zones", { ...project, components: { schemaVersion: 1, defs: [] } }],
    ["a float in card templates", { ...project, cardTemplates: [{ x: 1.5 }] }],
    ["a non-UUID id", { ...project, id: "project-1" }],
  ])("reject %s", (_name, value) => {
    expect(LocalProjectSchema.safeParse(value).success).toBe(false);
  });

  test("asset info allows only Phase 1 image types and safe paths", () => {
    const info = {
      projectId: project.id,
      path: "assets/fish.png",
      sha256: "ab".repeat(32),
      contentType: "image/png",
      size: 120,
    };
    expect(ProjectAssetInfoSchema.parse(info)).toEqual(info);
    expect(
      ProjectAssetInfoSchema.safeParse({ ...info, contentType: "image/svg+xml" }).success,
    ).toBe(false);
    expect(ProjectAssetInfoSchema.safeParse({ ...info, path: "../x.png" }).success).toBe(false);
  });

  test("hot-seat matches hold init and gapless events only", () => {
    const record = {
      id: "0192f3a4-5b6c-7d8e-9f01-23456789abce",
      projectId: project.id,
      init: { seats: ["0", "1"], seed: 9, options: {} },
      events: [
        { seq: 1, seat: "0", intent: { move: "manual", args: { op: "endTurn" } } },
        { seq: 2, seat: "1", intent: { move: "manual", args: { op: "endTurn" } } },
      ],
      updatedAt: "2026-11-04T10:00:00.000Z",
    };
    expect(HotSeatMatchRecordSchema.parse(record)).toEqual(record);
    expect(
      HotSeatMatchRecordSchema.safeParse({ ...record, events: record.events.slice(1) }).success,
    ).toBe(false);
    expect(HotSeatMatchRecordSchema.safeParse({ ...record, state: {} }).success).toBe(false);
  });
});
