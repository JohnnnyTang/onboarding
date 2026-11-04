import { type ClientView, ClientViewSchema, type JsonPatchOperation } from "@bgp/schema";
import jsonpatch from "fast-json-patch";

/**
 * Applies the room server's RFC 6902 operations to this seat's previous view
 * (fast-json-patch, the tech-stack default). Returns null when the operations do not apply
 * or the result is not a valid client view; the caller then asks for a `resync`.
 * The previous view is never modified.
 */
export function applyViewPatch(
  previous: ClientView,
  ops: readonly JsonPatchOperation[],
): ClientView | null {
  let next: unknown;
  try {
    const document = structuredClone(previous);
    // Validate each operation against the document; prototype modifications stay banned.
    next = jsonpatch.applyPatch(document, structuredClone([...ops]), true, true, true).newDocument;
  } catch {
    return null;
  }
  const parsed = ClientViewSchema.safeParse(next);
  return parsed.success ? parsed.data : null;
}
