import type { ClientView, JsonPatchOperation } from "@bgp/schema";
import jsonpatch from "fast-json-patch";

export type ViewUpdate =
  | { kind: "patch"; ops: JsonPatchOperation[] }
  | { kind: "snapshot"; view: ClientView };

/**
 * RFC 6902 operations from one seat's previous view to its next view (fast-json-patch,
 * the tech-stack default). Both inputs are that seat's own `playerView` output, so the
 * operations can only carry data from the next view or paths of the previous one.
 */
export function diffViews(previous: ClientView, next: ClientView): JsonPatchOperation[] {
  return jsonpatch.compare(previous, next) as JsonPatchOperation[];
}

/** Patches up to this size are always sent as patches, so they keep their `cause`. */
export const LARGE_PATCH_BYTES = 8 * 1024;

/**
 * A patch, or a full snapshot for a large change: a patch over `LARGE_PATCH_BYTES` that is
 * also longer than the view itself.
 */
export function viewUpdate(previous: ClientView | null, next: ClientView): ViewUpdate {
  if (previous === null) return { kind: "snapshot", view: next };
  const ops = diffViews(previous, next);
  const size = JSON.stringify(ops).length;
  if (size > LARGE_PATCH_BYTES && size > JSON.stringify(next).length) {
    return { kind: "snapshot", view: next };
  }
  return { kind: "patch", ops };
}

/** Every string a view contains, as a value or as an object key. */
export function viewStrings(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === "string") into.add(value);
  else if (Array.isArray(value)) for (const entry of value) viewStrings(entry, into);
  else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      into.add(key);
      viewStrings(entry, into);
    }
  }
  return into;
}
