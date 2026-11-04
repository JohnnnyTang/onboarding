import { z } from "zod";
import { IsoTimeSchema, JsonSchema, Sha256Schema, VersionPathSchema } from "./common.js";
import { GamePackageSchema, ManifestSchema } from "./manifest.js";
import { AcceptedEventSchema, MatchInitSchema } from "./rules.js";
import { ComponentsFileSchema } from "./table.js";

// Records of the browser's `bgp` IndexedDB database (data-model.md). Storage is a trust
// boundary: the web app parses every record it reads with these schemas.

const ProjectIdSchema = z.uuid();

/** Image types a project may import (components-and-table.md: no SVG). */
export const ProjectImageTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/avif",
]);
export type ProjectImageType = z.infer<typeof ProjectImageTypeSchema>;

/** A designer's local project. Its manifest and components always form a valid package. */
export const LocalProjectSchema = z
  .strictObject({
    id: ProjectIdSchema,
    name: z
      .string()
      .max(80)
      .regex(/^\S(?:.*\S)?$/, "Names need text without surrounding spaces"),
    mode: z.literal("sandbox"),
    manifest: ManifestSchema,
    components: ComponentsFileSchema,
    /** Card generator templates; T16 defines their shape. */
    cardTemplates: z.array(JsonSchema),
    /** Imported CSV files for the card generator; T16 defines their shape. */
    csvSources: z.array(JsonSchema),
    updatedAt: IsoTimeSchema,
    publishedVersionIds: z.array(z.uuid()),
  })
  .refine(
    (project) => project.manifest.mode === project.mode && project.manifest.name === project.name,
    "The manifest must match the project's mode and name",
  )
  .refine(
    (project) =>
      GamePackageSchema.safeParse({ manifest: project.manifest, components: project.components })
        .success,
    "The manifest and components must form a valid game package",
  );
export type LocalProject = z.infer<typeof LocalProjectSchema>;

/** An image of a project, without its bytes (the store keeps the Blob next to it). */
export const ProjectAssetInfoSchema = z.strictObject({
  projectId: ProjectIdSchema,
  path: VersionPathSchema,
  sha256: Sha256Schema,
  contentType: ProjectImageTypeSchema,
  size: z.int().nonnegative(),
});
export type ProjectAssetInfo = z.infer<typeof ProjectAssetInfoSchema>;

/** A hot-seat match: only init and accepted events are stored; the state is replayed. */
export const HotSeatMatchRecordSchema = z
  .strictObject({
    id: z.uuid(),
    projectId: ProjectIdSchema,
    init: MatchInitSchema,
    events: z.array(AcceptedEventSchema),
    updatedAt: IsoTimeSchema,
  })
  .refine(
    (match) => match.events.every((event, index) => event.seq === index + 1),
    "Events must be numbered from 1 without gaps",
  );
export type HotSeatMatchRecord = z.infer<typeof HotSeatMatchRecordSchema>;
