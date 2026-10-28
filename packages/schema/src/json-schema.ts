import { z } from "zod";
import * as auth from "./auth.js";
import * as common from "./common.js";
import * as http from "./http.js";
import * as manifest from "./manifest.js";
import * as protocol from "./protocol.js";
import * as rules from "./rules.js";
import * as rulesHost from "./rules-host.js";
import * as table from "./table.js";

// Callable contracts have no JSON representation; they are checked inside the sandbox.
const CALLABLE_SCHEMAS = [
  "RandomSchema",
  "EventsSchema",
  "SetupContextSchema",
  "MoveContextSchema",
  "MoveDefinitionSchema",
  "TurnConfigSchema",
  "PhaseDefinitionSchema",
  "GameDefinitionSchema",
];

// JsonSchema validates plain integer JSON without rebuilding it. Give only this
// custom validator an exact recursive representation; all other unsupported
// schemas still make export fail.
const JSON_REF = "#/$defs/IntegerJson";
const { $schema: _dialect, ...integer } = z.toJSONSchema(common.IntegerSchema);
const INTEGER_JSON: z.core.JSONSchema.JSONSchema = {
  anyOf: [
    { type: "null" },
    { type: "boolean" },
    integer,
    { type: "string" },
    { type: "array", items: { $ref: JSON_REF } },
    { type: "object", additionalProperties: { $ref: JSON_REF } },
  ],
};

export function contractJsonSchemas() {
  const documents: Record<string, z.core.JSONSchema.JSONSchema> = {};
  for (const [name, schema] of Object.entries({
    ...auth,
    ...common,
    ...http,
    ...manifest,
    ...protocol,
    ...rules,
    ...rulesHost,
    ...table,
  })) {
    if (
      !name.endsWith("Schema") ||
      CALLABLE_SCHEMAS.includes(name) ||
      !(schema instanceof z.ZodType)
    )
      continue;
    let usesJson = false;
    const exported = z.toJSONSchema(schema, {
      target: "draft-2020-12",
      reused: "ref",
      unrepresentable(ctx) {
        if (ctx.zodSchema !== common.JsonSchema) return "throw";
        usesJson = true;
        return { $ref: JSON_REF };
      },
    });
    documents[name] = {
      ...exported,
      ...(usesJson ? { $defs: { ...exported.$defs, IntegerJson: INTEGER_JSON } } : {}),
      title: name.replace(/Schema$/, ""),
    };
  }
  return documents;
}
