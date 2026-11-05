import type { CardPlan } from "@bgp/card-generator";
import type {
  CardDef,
  CardField,
  CardTemplate,
  CardTextField,
  ComponentDef,
  CsvSource,
  LocalProject,
} from "@bgp/schema";
import {
  instancesOf,
  nextId,
  PLACEHOLDER_IMAGE,
  type SetupInstance,
  slugFor,
  withComponents,
} from "../projects/project-model";
import type { CsvTable } from "./csv";

// Pure edits of a project's card templates and CSV sources, and of the card components a
// template generates (contracts/card-generator.md#generated-cards).

export type FieldKind = CardField["kind"];
export type Face = NonNullable<SetupInstance["face"]>;

export const FIELD_KINDS: readonly { kind: FieldKind; label: string }[] = [
  { kind: "text", label: "Text" },
  { kind: "image", label: "Image" },
  { kind: "box", label: "Box" },
];

/** Where a generated card's face is stored among the project's images. */
export function facePath(cardId: string): string {
  return `assets/cards/${cardId}.png`;
}

export function findTemplate(project: LocalProject, id: string): CardTemplate | undefined {
  return project.cardTemplates.find((template) => template.id === id);
}

export function findSource(project: LocalProject, id: string | null): CsvSource | null {
  return id === null ? null : (project.csvSources.find((source) => source.id === id) ?? null);
}

/** Drops column choices the source does not have. */
function fitToSource(template: CardTemplate, source: CsvSource | null): CardTemplate {
  const has = (column: string | null) => column !== null && !!source?.columns.includes(column);
  return {
    ...template,
    data: {
      source: source?.id ?? null,
      columns: Object.fromEntries(
        Object.entries(template.data.columns).filter(([, column]) => has(column)),
      ),
      idColumn: has(template.data.idColumn) ? template.data.idColumn : null,
      nameColumn: has(template.data.nameColumn) ? template.data.nameColumn : null,
      countColumn: has(template.data.countColumn) ? template.data.countColumn : null,
    },
  };
}

/**
 * Adds an imported CSV table. A file with the name of an existing source replaces it, and
 * templates using it drop mappings to columns the new file lacks.
 */
export function addCsvSource(
  project: LocalProject,
  name: string,
  table: CsvTable,
  id: string,
  importedAt: string,
): { project: LocalProject; id: string } {
  const existing = project.csvSources.find((source) => source.name === name);
  const source: CsvSource = {
    id: existing?.id ?? id,
    name: name.slice(0, 120),
    columns: table.columns,
    rows: table.rows,
    importedAt,
  };
  return {
    id: source.id,
    project: {
      ...project,
      csvSources: existing
        ? project.csvSources.map((other) => (other.id === source.id ? source : other))
        : [...project.csvSources, source],
      cardTemplates: project.cardTemplates.map((template) =>
        template.data.source === source.id ? fitToSource(template, source) : template,
      ),
    },
  };
}

/** Removes a source; templates that used it generate from their defaults until given another. */
export function removeCsvSource(project: LocalProject, id: string): LocalProject {
  return {
    ...project,
    csvSources: project.csvSources.filter((source) => source.id !== id),
    cardTemplates: project.cardTemplates.map((template) =>
      template.data.source === id ? fitToSource(template, null) : template,
    ),
  };
}

const INK = "#1d2733";

function textField(
  id: string,
  label: string,
  rect: CardField["rect_mm"],
  text: string,
): CardTextField {
  return {
    id,
    label,
    kind: "text",
    rect_mm: rect,
    text,
    size_mm: 5,
    color: INK,
    font: "sans-serif",
    bold: false,
    align: "center",
    valign: "middle",
  };
}

/** A new 63 × 88 mm template with a title, an image and a text field. */
export function addTemplate(
  project: LocalProject,
  name: string,
): { project: LocalProject; id: string } {
  const trimmed = name.trim().slice(0, 80) || "Cards";
  const taken = project.cardTemplates.map((template) => template.id);
  const base = slugFor(trimmed).slice(0, 30);
  const id = taken.includes(base) ? nextId(base, taken) : base;
  const title = textField("title", "Title", { x: 4, y: 4, w: 55, h: 10 }, trimmed);
  const template: CardTemplate = {
    id,
    name: trimmed,
    size_mm: [63, 88],
    background: "#ffffff",
    fields: [
      { ...title, bold: true, size_mm: 6 },
      {
        id: "art",
        label: "Art",
        kind: "image",
        rect_mm: { x: 4, y: 16, w: 55, h: 48 },
        image: null,
        fit: "contain",
      },
      textField("body", "Text", { x: 4, y: 66, w: 55, h: 18 }, ""),
    ],
    back: null,
    data: { source: null, columns: {}, idColumn: null, nameColumn: null, countColumn: null },
    generated: [],
  };
  return { project: { ...project, cardTemplates: [...project.cardTemplates, template] }, id };
}

/**
 * Saves a template; its data is fitted to the source it names. The list of generated cards
 * is kept as stored: only a generation changes it.
 */
export function updateTemplate(project: LocalProject, template: CardTemplate): LocalProject {
  const fitted = fitToSource(template, findSource(project, template.data.source));
  return {
    ...project,
    cardTemplates: project.cardTemplates.map((other) =>
      other.id === template.id ? { ...fitted, generated: other.generated } : other,
    ),
  };
}

/** Removes a template. The cards it generated stay as ordinary components. */
export function removeTemplate(project: LocalProject, id: string): LocalProject {
  return { ...project, cardTemplates: project.cardTemplates.filter((other) => other.id !== id) };
}

/** A new field of `kind` in the middle of the card, with a unique id. */
export function newField(template: CardTemplate, kind: FieldKind): CardField {
  const id = nextId(
    kind,
    template.fields.map((field) => field.id),
  );
  const [w, h] = template.size_mm;
  const rect = {
    x: Math.round(w / 4),
    y: Math.round(h / 3),
    w: Math.round(w / 2),
    h: Math.round(h / 6),
  };
  const label = `${FIELD_KINDS.find((entry) => entry.kind === kind)?.label ?? kind} ${id.split("-").at(-1)}`;
  switch (kind) {
    case "text":
      return textField(id, label, rect, label);
    case "image":
      return { id, label, kind, rect_mm: rect, image: null, fit: "contain" };
    case "box":
      return { id, label, kind, rect_mm: rect, color: "#d9e2ec", radius_mm: 2 };
  }
}

/** Why the plan cannot be applied: duplicate ids, or ids of components made another way. */
export function generationErrors(
  project: LocalProject,
  template: CardTemplate,
  plan: CardPlan,
): string[] {
  const own = new Set(template.generated);
  const taken = new Map(project.components.defs.map((def) => [def.id, def]));
  const conflicts = plan.cards.flatMap((card) => {
    const other = taken.get(card.id);
    if (!other || own.has(card.id)) return [];
    return [`"${card.id}" is already the id of ${other.name ?? other.id}; choose another id`];
  });
  return [...plan.errors, ...conflicts];
}

function backFor(defs: ComponentDef[], template: CardTemplate): string {
  const backs = defs.filter((def) => def.kind === "cardBack");
  const chosen = backs.find((def) => def.id === template.back) ?? backs[0];
  if (chosen) return chosen.id;
  const id = nextId(
    "back",
    defs.map((def) => def.id),
  );
  defs.push({ id, kind: "cardBack", name: "Card back", image: PLACEHOLDER_IMAGE });
  return id;
}

/**
 * Writes the planned cards as card components (their faces at `facePath`). Cards the
 * template generated before but not now are removed with their setup lines; their face
 * paths are returned so the images can be deleted. Call only when `generationErrors` is
 * empty.
 */
export function applyGeneration(
  project: LocalProject,
  templateId: string,
  plan: CardPlan,
): { project: LocalProject; staleFaces: string[] } {
  const template = findTemplate(project, templateId);
  if (!template) return { project, staleFaces: [] };
  const planned = new Set(plan.cards.map((card) => card.id));
  const stale = new Set(template.generated.filter((id) => !planned.has(id)));
  const defs = project.components.defs.filter((def) => !stale.has(def.id));
  const back = backFor(defs, template);
  for (const card of plan.cards) {
    const index = defs.findIndex((def) => def.id === card.id);
    const previous = index >= 0 ? defs[index] : undefined;
    const def: CardDef = {
      ...(previous?.kind === "card" ? previous : {}),
      id: card.id,
      kind: "card",
      name: card.name,
      size_mm: [template.size_mm[0], template.size_mm[1]],
      front: facePath(card.id),
      back,
    };
    if (index >= 0) defs[index] = def;
    else defs.push(def);
  }
  const updated = withComponents(project, {
    defs,
    instances: instancesOf(project).filter((instance) => !stale.has(instance.def)),
  });
  return {
    project: {
      ...updated,
      cardTemplates: updated.cardTemplates.map((other) =>
        other.id === templateId ? { ...other, generated: [...planned] } : other,
      ),
    },
    staleFaces: [...stale].map(facePath),
  };
}

/**
 * Places the template's generated cards in `zone`, `counts` copies each (1 when missing),
 * replacing earlier setup lines of those cards in that zone.
 */
export function addGeneratedToSetup(
  project: LocalProject,
  templateId: string,
  counts: ReadonlyMap<string, number>,
  zone: string,
  face: Face,
  shuffle: boolean,
): LocalProject {
  const template = findTemplate(project, templateId);
  if (!template) return project;
  const cards = template.generated.filter((id) =>
    project.components.defs.some((def) => def.id === id && def.kind === "card"),
  );
  const ids = new Set(cards);
  return withComponents(project, {
    instances: [
      ...instancesOf(project).filter(
        (instance) => !(ids.has(instance.def) && instance.zone === zone),
      ),
      ...cards.map((def) => ({
        def,
        zone,
        count: counts.get(def) ?? 1,
        face,
        ...(shuffle ? { shuffle: true } : {}),
      })),
    ],
  });
}
