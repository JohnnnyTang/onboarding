import { type Json, JsonSchema } from "@bgp/schema";

/** Serialize sorted keys directly: rebuilding an object would reorder numeric keys. */
function encode(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${encode(value[key] as Json)}`)
    .join(",")}}`;
}

export function canonicalJson(value: unknown): string {
  return encode(JsonSchema.parse(value));
}

/** JSON round-trip preserves arbitrary own keys and severs references to game code. */
export function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}
