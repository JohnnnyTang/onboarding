import { type CardPlan, loadCardImages, planCards, renderCardPngs } from "@bgp/card-generator";
import type { LocalProject } from "@bgp/schema";
import { sha256Hex } from "../projects/images";
import type { ProjectAsset } from "../projects/project-store";
import type { ImageChange } from "../projects/use-project";
import {
  applyGeneration,
  facePath,
  findSource,
  findTemplate,
  generationErrors,
} from "./card-model";
import { ensureCardFonts } from "./fonts";

// Generating a template's cards: plan them, draw every face at 300 dpi, then save the faces
// and the card components together (contracts/card-generator.md#generated-cards).

export interface Generation {
  templateId: string;
  plan: CardPlan;
  faces: ProjectAsset[];
}

export type GenerationResult =
  | { ok: true; generation: Generation }
  | { ok: false; errors: string[] };

/** Draws the faces of a template's cards. Nothing is saved yet. */
export async function renderGeneration(
  project: LocalProject,
  assets: readonly ProjectAsset[],
  templateId: string,
  onProgress?: (done: number, total: number) => void,
): Promise<GenerationResult> {
  const template = findTemplate(project, templateId);
  if (!template) return { ok: false, errors: ["The template no longer exists."] };
  try {
    await ensureCardFonts();
  } catch {
    return {
      ok: false,
      errors: ["The card fonts could not be loaded; reload the page and try again."],
    };
  }
  const paths = assets.map((asset) => asset.path);
  const plan = planCards(template, findSource(project, template.data.source), paths);
  const errors = generationErrors(project, template, plan);
  if (errors.length > 0) return { ok: false, errors };

  const used = new Set(plan.cards.flatMap((card) => Object.values(card.values)));
  const images = await loadCardImages(
    assets.filter((asset) => used.has(asset.path)).map((asset) => [asset.path, asset.blob]),
  );
  try {
    const blobs = await renderCardPngs(
      template,
      plan.cards.map((card) => card.values),
      images,
      onProgress ? { onProgress } : {},
    );
    const faces = await Promise.all(
      blobs.map(async (blob, index): Promise<ProjectAsset> => {
        const id = plan.cards[index]?.id ?? "";
        return {
          projectId: project.id,
          path: facePath(id),
          sha256: await sha256Hex(await blob.arrayBuffer()),
          contentType: "image/png",
          size: blob.size,
          blob,
        };
      }),
    );
    return { ok: true, generation: { templateId, plan, faces } };
  } finally {
    for (const image of images.values()) image.close();
  }
}

/**
 * The change that stores a rendered generation on the newest saved project. It refuses when
 * the project changed so that the plan no longer applies.
 */
export function generationChange(generation: Generation) {
  return (current: LocalProject): ImageChange | string[] => {
    const template = findTemplate(current, generation.templateId);
    if (!template) return ["The template no longer exists."];
    const errors = generationErrors(current, template, generation.plan);
    if (errors.length > 0) return errors;
    const { project, staleFaces } = applyGeneration(
      current,
      generation.templateId,
      generation.plan,
    );
    return { project, put: generation.faces, remove: staleFaces };
  };
}
