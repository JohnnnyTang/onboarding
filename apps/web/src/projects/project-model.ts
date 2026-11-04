import {
  type ComponentDef,
  componentAssetRefs,
  type LocalProject,
  LocalProjectSchema,
  type SandboxSetup,
  type ZoneDef,
} from "@bgp/schema";

// Pure edits of a local project. Each returns a new project; the editor saves it only when
// `checkProject` finds no errors, so a stored project always forms a valid sandbox package.

export type ComponentKind = ComponentDef["kind"];
export type SetupInstance = SandboxSetup["instances"][number];

export const COMPONENT_KINDS: readonly { kind: ComponentKind; label: string }[] = [
  { kind: "card", label: "Card" },
  { kind: "cardBack", label: "Card back" },
  { kind: "token", label: "Token" },
  { kind: "die", label: "Die" },
  { kind: "board", label: "Board" },
  { kind: "piece", label: "Piece" },
];

export const MAX_PLAYERS = 8;

/** A manifest id from a name: "Harbor Market!" → "harbor-market". Always a valid slug. */
export function slugFor(name: string): string {
  const slug = name
    .normalize("NFKD")
    // Drop the accents NFKD separated from their letters: "Été" → "ete".
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  if (slug.length >= 3 && /^[a-z0-9]/.test(slug)) return slug;
  return `${slug === "" ? "game" : slug}-game`.replace(/^-+/, "");
}

export function createProject(name: string, id: string, now: string): LocalProject {
  const trimmed = name.trim();
  return {
    id,
    name: trimmed,
    mode: "sandbox",
    manifest: {
      schemaVersion: 1,
      id: slugFor(trimmed),
      name: trimmed,
      version: "0.1.0",
      mode: "sandbox",
      sdk: 1,
      players: { min: 2, max: 4 },
      components: "components.json",
    },
    components: { schemaVersion: 1, defs: [], zones: [], setup: { instances: [] } },
    cardTemplates: [],
    csvSources: [],
    updatedAt: now,
    publishedVersionIds: [],
  };
}

export interface ProjectDetails {
  name: string;
  playersMin: number;
  playersMax: number;
  description: string;
}

export function updateDetails(project: LocalProject, details: ProjectDetails): LocalProject {
  const name = details.name.trim();
  const description = details.description.trim();
  const { description: _old, ...manifest } = project.manifest;
  return {
    ...project,
    name,
    manifest: {
      ...manifest,
      name,
      players: { min: details.playersMin, max: details.playersMax },
      ...(description === "" ? {} : { description }),
    },
  };
}

function zonesOf(project: LocalProject): ZoneDef[] {
  return project.components.zones ?? [];
}

function instancesOf(project: LocalProject): SetupInstance[] {
  return project.components.setup?.instances ?? [];
}

function withComponents(
  project: LocalProject,
  change: { defs?: ComponentDef[]; zones?: ZoneDef[]; instances?: SetupInstance[] },
): LocalProject {
  return {
    ...project,
    components: {
      ...project.components,
      defs: change.defs ?? project.components.defs,
      zones: change.zones ?? zonesOf(project),
      setup: { instances: change.instances ?? instancesOf(project) },
    },
  };
}

/** The first `<prefix>-<n>` not used by any id in `taken`. */
export function nextId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; ; n += 1) {
    const id = `${prefix}-${n}`;
    if (!used.has(id)) return id;
  }
}

const KIND_PREFIX: Record<ComponentKind, string> = {
  card: "card",
  cardBack: "back",
  token: "token",
  die: "die",
  board: "board",
  piece: "piece",
};

/** Image used for a new component: the first imported image, else a path to import later. */
export const PLACEHOLDER_IMAGE = "assets/missing.png";

/**
 * Adds a component with sensible defaults. A card needs a card back, so adding the first
 * card also adds one.
 */
export function addComponent(
  project: LocalProject,
  kind: ComponentKind,
  image: string = PLACEHOLDER_IMAGE,
): { project: LocalProject; id: string } {
  const defs = [...project.components.defs];
  const ids = () => defs.map((def) => def.id);
  const id = nextId(KIND_PREFIX[kind], ids());
  const name = `${COMPONENT_KINDS.find((entry) => entry.kind === kind)?.label ?? kind} ${id.split("-").at(-1)}`;
  switch (kind) {
    case "card": {
      let back = defs.find((def) => def.kind === "cardBack")?.id;
      if (back === undefined) {
        back = nextId("back", ids());
        defs.push({ id: back, kind: "cardBack", name: "Card back", image });
      }
      defs.push({ id, kind, name, size_mm: [63, 88], front: image, back });
      break;
    }
    case "cardBack":
      defs.push({ id, kind, name, image });
      break;
    case "token":
      defs.push({ id, kind, name, shape: "circle", size_mm: [20, 20], front: image });
      break;
    case "die":
      defs.push({ id, kind, name, sides: 6, size_mm: 16 });
      break;
    case "board":
      defs.push({ id, kind, name, size_mm: [300, 300], image });
      break;
    case "piece":
      defs.push({ id, kind, name, size_mm: [16, 16, 24], image });
      break;
  }
  return { project: withComponents(project, { defs }), id };
}

export function updateComponent(project: LocalProject, def: ComponentDef): LocalProject {
  return withComponents(project, {
    defs: project.components.defs.map((existing) => (existing.id === def.id ? def : existing)),
  });
}

/** Why a component cannot be removed, or null. Setup entries using it are removed with it. */
export function removalBlocker(project: LocalProject, id: string): string | null {
  const users = project.components.defs.filter((def) => def.kind === "card" && def.back === id);
  if (users.length === 0) return null;
  return `Used as the back of ${users.map((def) => def.name ?? def.id).join(", ")}`;
}

export function removeComponent(project: LocalProject, id: string): LocalProject {
  if (removalBlocker(project, id) !== null) return project;
  return withComponents(project, {
    defs: project.components.defs.filter((def) => def.id !== id),
    instances: instancesOf(project).filter((instance) => instance.def !== id),
  });
}

export type ZoneRect = ZoneDef["rect_mm"];

export function addZone(
  project: LocalProject,
  rect: ZoneRect,
): { project: LocalProject; id: string } {
  const id = nextId(
    "zone",
    zonesOf(project).map((zone) => zone.id),
  );
  const zone: ZoneDef = { id, layout: "stack", rect_mm: rect, visibility: "public", label: id };
  return { project: withComponents(project, { zones: [...zonesOf(project), zone] }), id };
}

export function updateZone(project: LocalProject, zone: ZoneDef): LocalProject {
  return withComponents(project, {
    zones: zonesOf(project).map((existing) => (existing.id === zone.id ? zone : existing)),
  });
}

/** Removes a zone and the setup entries that place components in it. */
export function removeZone(project: LocalProject, id: string): LocalProject {
  return withComponents(project, {
    zones: zonesOf(project).filter((zone) => zone.id !== id),
    instances: instancesOf(project).filter(
      (instance) => instance.zone !== id && !instance.zone.startsWith(`${id}:`),
    ),
  });
}

/** Zones a setup entry may name: each declared zone, and each seat's copy of "each" zones. */
export function setupZoneChoices(project: LocalProject): { id: string; label: string }[] {
  return zonesOf(project).flatMap((zone) => {
    const name = zone.label ?? zone.id;
    if (zone.owner !== "each") return [{ id: zone.id, label: name }];
    const seats = Array.from({ length: project.manifest.players.min }, (_, seat) => ({
      id: `${zone.id}:${seat}`,
      label: `${name} (seat ${seat + 1} only)`,
    }));
    return [{ id: zone.id, label: `${name} (every seat)` }, ...seats];
  });
}

export function setInstances(project: LocalProject, instances: SetupInstance[]): LocalProject {
  return withComponents(project, { instances });
}

/**
 * Problems that keep a change from being saved. Beyond the stored schema, the sandbox must
 * be able to set up for the smallest player count: fixed owners must be seated, and
 * seat-specific setup entries must name a seat that always plays.
 */
export function projectErrors(project: LocalProject): string[] {
  const parsed = LocalProjectSchema.safeParse(project);
  const errors = parsed.success
    ? []
    : parsed.error.issues.map((issue) =>
        issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
      );
  const { min, max } = project.manifest.players;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > MAX_PLAYERS || min > max)
    errors.push(`Players must be whole numbers with 1 ≤ min ≤ max ≤ ${MAX_PLAYERS}`);
  for (const zone of zonesOf(project)) {
    if (zone.owner !== undefined && zone.owner !== "each" && Number(zone.owner) >= min) {
      errors.push(`Zone ${zone.label ?? zone.id} belongs to a seat that may not play`);
    }
  }
  for (const instance of instancesOf(project)) {
    const [base, seat] = instance.zone.split(":");
    const zone = zonesOf(project).find((candidate) => candidate.id === base);
    if (seat !== undefined && (zone?.owner !== "each" || Number(seat) >= min)) {
      errors.push(`Setup places items in ${instance.zone}, which may not exist`);
    }
  }
  return errors;
}

/** Image paths components refer to that the project has not imported. */
export function missingImages(project: LocalProject, imported: Iterable<string>): string[] {
  const have = new Set(imported);
  return [...new Set(componentAssetRefs(project.components))].filter((ref) => !have.has(ref));
}

/** Image paths in use, so the image list can say which ones components use. */
export function usedImages(project: LocalProject): Set<string> {
  return new Set(componentAssetRefs(project.components));
}

/** Smallest table that holds every zone, as the sandbox computes it (Q-009). */
export function tableSize(zones: readonly ZoneDef[]): [number, number] {
  return [
    Math.max(800, ...zones.map((zone) => Math.ceil(2 * Math.abs(zone.rect_mm.x) + zone.rect_mm.w))),
    Math.max(600, ...zones.map((zone) => Math.ceil(2 * Math.abs(zone.rect_mm.y) + zone.rect_mm.h))),
  ];
}
