import { planCards } from "@bgp/card-generator";
import type { LocalProject } from "@bgp/schema";
import { describe, expect, it } from "vitest";
import { addComponent, addZone, createProject, projectErrors } from "../projects/project-model";
import {
  addCsvSource,
  addGeneratedToSetup,
  addTemplate,
  applyGeneration,
  facePath,
  findTemplate,
  generationErrors,
  newField,
  removeCsvSource,
  removeTemplate,
  updateTemplate,
} from "./card-model";

const ID = "0192f3a4-5b6c-7d8e-9f01-23456789aaaa";
const CSV = "0192f3a4-5b6c-7d8e-9f01-23456789cccc";
const NOW = "2026-11-04T10:00:00.000Z";

const goods = {
  columns: ["id", "name", "color", "copies"],
  rows: [
    ["fish-1", "Fish 1", "#2f6fb0", "4"],
    ["salt-1", "Salt 1", "#8a8f98", "3"],
  ],
};

/** A project with the goods CSV and a "Goods" template mapped to it. */
function setup(): LocalProject {
  let project = createProject("Cards", ID, NOW);
  project = addCsvSource(project, "goods.csv", goods, CSV, NOW).project;
  project = addTemplate(project, "Goods").project;
  const template = findTemplate(project, "goods");
  if (!template) throw new Error("no template");
  return updateTemplate(project, {
    ...template,
    data: {
      source: CSV,
      columns: { title: "name" },
      idColumn: "id",
      nameColumn: "name",
      countColumn: "copies",
    },
  });
}

function generate(project: LocalProject) {
  const template = findTemplate(project, "goods");
  if (!template) throw new Error("no template");
  const source = project.csvSources[0] ?? null;
  const plan = planCards(template, source, []);
  return { plan, errors: generationErrors(project, template, plan), template };
}

describe("card templates in a project", () => {
  it("adds a valid template with a unique id from its name", () => {
    let project = setup();
    expect(projectErrors(project)).toEqual([]);
    project = addTemplate(project, "Goods").project;
    expect(project.cardTemplates.map((template) => template.id)).toEqual(["goods", "goods-1"]);
    expect(projectErrors(project)).toEqual([]);
  });

  it("adds fields with unique ids that validate", () => {
    let project = setup();
    const template = findTemplate(project, "goods");
    if (!template) throw new Error("no template");
    const fields = [...template.fields];
    for (const kind of ["text", "image", "box", "text"] as const) {
      fields.push(newField({ ...template, fields }, kind));
    }
    project = updateTemplate(project, { ...template, fields });
    expect(fields.map((field) => field.id).slice(3)).toEqual([
      "text-1",
      "image-1",
      "box-1",
      "text-2",
    ]);
    expect(projectErrors(project)).toEqual([]);
  });

  it("replaces a CSV of the same name and drops mappings to columns it lacks", () => {
    let project = setup();
    const replaced = addCsvSource(
      project,
      "goods.csv",
      { columns: ["id", "color"], rows: [["a", "#fff"]] },
      "0192f3a4-5b6c-7d8e-9f01-23456789dddd",
      NOW,
    );
    project = replaced.project;
    expect(replaced.id).toBe(CSV);
    expect(project.csvSources).toHaveLength(1);
    expect(project.cardTemplates[0]?.data).toEqual({
      source: CSV,
      columns: {},
      idColumn: "id",
      nameColumn: null,
      countColumn: null,
    });
    project = removeCsvSource(project, CSV);
    expect(project.csvSources).toEqual([]);
    expect(project.cardTemplates[0]?.data.source).toBeNull();
    expect(projectErrors(project)).toEqual([]);
  });

  it("keeps the generated list when a template is saved from an older draft", () => {
    const project = setup();
    const { plan } = generate(project);
    const generated = applyGeneration(project, "goods", plan).project;
    const draft = project.cardTemplates[0];
    if (!draft) throw new Error("no template");
    const saved = updateTemplate(generated, { ...draft, name: "Renamed" });
    expect(saved.cardTemplates[0]).toMatchObject({
      name: "Renamed",
      generated: ["fish-1", "salt-1"],
    });
  });
});

describe("generated cards", () => {
  it("writes one card per row with its face, and a card back when there is none", () => {
    const project = setup();
    const { plan, errors } = generate(project);
    expect(errors).toEqual([]);
    const { project: next, staleFaces } = applyGeneration(project, "goods", plan);
    expect(staleFaces).toEqual([]);
    expect(next.components.defs).toEqual([
      { id: "back-1", kind: "cardBack", name: "Card back", image: "assets/missing.png" },
      {
        id: "fish-1",
        kind: "card",
        name: "Fish 1",
        size_mm: [63, 88],
        front: facePath("fish-1"),
        back: "back-1",
      },
      {
        id: "salt-1",
        kind: "card",
        name: "Salt 1",
        size_mm: [63, 88],
        front: "assets/cards/salt-1.png",
        back: "back-1",
      },
    ]);
    expect(next.cardTemplates[0]?.generated).toEqual(["fish-1", "salt-1"]);
    expect(projectErrors(next)).toEqual([]);
  });

  it("regenerating replaces its own cards, removes stale ones with their setup lines", () => {
    let project = setup();
    project = addZone(project, { x: 0, y: 0, w: 100, h: 100 }).project;
    project = applyGeneration(project, "goods", generate(project).plan).project;
    const counts = new Map([
      ["fish-1", 4],
      ["salt-1", 3],
    ]);
    project = addGeneratedToSetup(project, "goods", counts, "zone-1", "down", true);
    expect(project.components.setup?.instances).toEqual([
      { def: "fish-1", zone: "zone-1", count: 4, face: "down", shuffle: true },
      { def: "salt-1", zone: "zone-1", count: 3, face: "down", shuffle: true },
    ]);
    // Placing again in the same zone replaces the lines rather than adding more.
    project = addGeneratedToSetup(project, "goods", new Map(), "zone-1", "up", false);
    expect(project.components.setup?.instances).toEqual([
      { def: "fish-1", zone: "zone-1", count: 1, face: "up" },
      { def: "salt-1", zone: "zone-1", count: 1, face: "up" },
    ]);

    // The CSV loses salt and gains tea.
    project = addCsvSource(
      project,
      "goods.csv",
      { ...goods, rows: [goods.rows[0] ?? [], ["tea-1", "Tea 1", "#3a7d44", "2"]] },
      CSV,
      NOW,
    ).project;
    const { plan, errors } = generate(project);
    expect(errors).toEqual([]);
    const { project: next, staleFaces } = applyGeneration(project, "goods", plan);
    expect(staleFaces).toEqual(["assets/cards/salt-1.png"]);
    expect(next.components.defs.map((def) => def.id)).toEqual(["back-1", "fish-1", "tea-1"]);
    expect(next.components.setup?.instances.map((line) => line.def)).toEqual(["fish-1"]);
    expect(projectErrors(next)).toEqual([]);
  });

  it("uses the chosen back, else the first one", () => {
    let project = addComponent(setup(), "cardBack", "assets/b.png").project;
    project = addComponent(project, "cardBack", "assets/c.png").project;
    const first = applyGeneration(project, "goods", generate(project).plan).project;
    expect(first.components.defs.find((def) => def.id === "fish-1")).toMatchObject({
      back: "back-1",
    });
    const template = findTemplate(project, "goods");
    if (!template) throw new Error("no template");
    project = updateTemplate(project, { ...template, back: "back-2" });
    const chosen = applyGeneration(project, "goods", generate(project).plan).project;
    expect(chosen.components.defs.find((def) => def.id === "fish-1")).toMatchObject({
      back: "back-2",
    });
  });

  it("refuses ids of components the template did not make", () => {
    let project = addComponent(setup(), "card", "assets/a.png").project;
    project = addCsvSource(
      project,
      "goods.csv",
      { ...goods, rows: [["card-1", "Clash", "", "1"]] },
      CSV,
      NOW,
    ).project;
    expect(generate(project).errors).toEqual([
      '"card-1" is already the id of Card 1; choose another id',
    ]);
  });

  it("leaves generated cards in place when their template is removed", () => {
    let project = setup();
    project = applyGeneration(project, "goods", generate(project).plan).project;
    project = removeTemplate(project, "goods");
    expect(project.cardTemplates).toEqual([]);
    expect(project.components.defs.map((def) => def.id)).toContain("fish-1");
  });
});
