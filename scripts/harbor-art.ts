// Harbor Market card art inputs (T16): games/harbor-market/art/templates.json and goods.csv,
// checked against the game's components. scripts/generate-harbor-art.ts draws them.
import { readFile } from "node:fs/promises";
import { parseCsv } from "../apps/web/src/cards/csv.js";
import { type CardValues, defaultValues, planCards } from "../packages/card-generator/src/index.js";
import {
  type CardTemplate,
  CardTemplateSchema,
  ComponentsFileSchema,
  componentAssetRefs,
} from "../packages/schema/src/index.js";

export const GAME = new URL("../games/harbor-market/", import.meta.url);

export interface HarborArt {
  goods: CardTemplate;
  back: CardTemplate;
  /** Output path (relative to the game) → template and values. */
  faces: Map<string, { template: CardTemplate; values: CardValues }>;
}

/** Reads the templates and CSV and checks they produce exactly the game's images. */
export async function harborArt(): Promise<HarborArt> {
  const templates = JSON.parse(await readFile(new URL("art/templates.json", GAME), "utf8"));
  const goods = CardTemplateSchema.parse(templates.goods);
  const back = CardTemplateSchema.parse(templates.back);
  const csv = parseCsv(await readFile(new URL("art/goods.csv", GAME), "utf8"));
  if (!csv.ok) throw new Error(`goods.csv: ${csv.problems.join("; ")}`);
  const plan = planCards(goods, csv.table, []);
  if (plan.errors.length > 0 || plan.warnings.length > 0) {
    throw new Error([...plan.errors, ...plan.warnings].join("; "));
  }

  const components = ComponentsFileSchema.parse(
    JSON.parse(await readFile(new URL("components.json", GAME), "utf8")),
  );
  const faces = new Map<string, { template: CardTemplate; values: CardValues }>();
  for (const card of plan.cards) {
    const def = components.defs.find((candidate) => candidate.id === card.id);
    if (def?.kind !== "card") throw new Error(`goods.csv makes ${card.id}, which is not a card`);
    faces.set(def.front, { template: goods, values: card.values });
    const backDef = components.defs.find((candidate) => candidate.id === def.back);
    if (backDef?.kind !== "cardBack" || backDef.id !== back.id) {
      throw new Error(`${card.id} has back ${def.back}, not the ${back.id} template`);
    }
    faces.set(backDef.image, { template: back, values: defaultValues(back) });
  }
  const wanted = [...new Set(componentAssetRefs(components))].sort();
  const made = [...faces.keys()].sort();
  if (JSON.stringify(wanted) !== JSON.stringify(made)) {
    throw new Error(`Art covers ${made.join(", ")} but the game uses ${wanted.join(", ")}`);
  }
  return { goods, back, faces };
}
