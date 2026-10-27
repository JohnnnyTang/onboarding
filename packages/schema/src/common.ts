import { z } from "zod";

export const IntegerSchema = z.int();
export const NonnegativeIntegerSchema = IntegerSchema.nonnegative();
export const PositiveIntegerSchema = IntegerSchema.positive();
export const Uint32Schema = IntegerSchema.min(0).max(0xffff_ffff);
export const SeatIdSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
export type SeatId = z.infer<typeof SeatIdSchema>;
export const IdSchema = z.string().min(1);
export const SlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{2,47}$/);
export const DefinitionIdSchema = z.string().regex(/^[a-z0-9-]+$/);
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const IsoTimeSchema = z.iso.datetime({ offset: true });
export const VersionPathSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/)
  .refine(
    (path) => path.split("/").every((part) => part !== "." && !part.includes("..")),
    "Paths must be relative and contain no '..' or '.' segments",
  );
export const AssetRefSchema = VersionPathSchema.refine(
  (path) => !/\.(svg|wasm)$/i.test(path),
  "SVG and game WASM assets are not allowed in Phase 1",
);
export type AssetRef = z.infer<typeof AssetRefSchema>;
export const ImageAssetRefSchema = AssetRefSchema.refine(
  (path) => /\.(png|jpe?g|webp|avif)$/i.test(path),
  "Phase 1 images must be PNG, JPEG, WebP or AVIF",
);
export const PositionSchema = z.tuple([IntegerSchema, IntegerSchema]);
export const RotationSchema = IntegerSchema.min(0).max(359);
export const FaceSchema = z.enum(["up", "down"]);
export const MatchStatusSchema = z.enum(["lobby", "active", "finished", "abandoned"]);
export type MatchStatus = z.infer<typeof MatchStatusSchema>;
export const VisibilitySchema = z.enum(["private", "unlisted"]);
export type Visibility = z.infer<typeof VisibilitySchema>;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// Check the input before recursive parsing so cycles and exotic objects fail cleanly.
function isJson(value: unknown, ancestors: readonly object[] = []): value is Json {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (typeof value !== "object" || ancestors.includes(value)) return false;
  const next = [...ancestors, value];
  if (Array.isArray(value)) {
    return (
      Reflect.ownKeys(value).length === value.length + 1 &&
      Object.keys(value).length === value.length &&
      Array.from(value).every((entry) => isJson(entry, next))
    );
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).length === Object.keys(value).length &&
    Object.values(value).every((entry) => isJson(entry, next))
  );
}

// A record parser drops an own '__proto__' key. Validate without rebuilding the
// value so arbitrary JSON keys survive unchanged (including during replay).
export const JsonSchema = z.custom<Json>(
  (value) => isJson(value),
  "Expected integer-only JSON without cycles or non-JSON objects",
);

export const RejectCodeSchema = z.enum([
  "MATCH_FINISHED",
  "NOT_YOUR_TURN",
  "MOVE_NOT_ALLOWED",
  "UNKNOWN_MOVE",
  "INVALID_ARGS",
  "INVALID_MOVE",
  "GAME_ERROR",
]);
export type RejectCode = z.infer<typeof RejectCodeSchema>;
export const ErrorCodeSchema = z.enum([
  "PROTOCOL_VERSION",
  "BAD_MESSAGE",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "MATCH_NOT_FOUND",
  "MATCH_NOT_ACTIVE",
  ...RejectCodeSchema.options,
  "RATE_LIMITED",
  "SEAT_TAKEN_OVER",
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "CONFLICT",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export const GameCodeSchema = z.string().regex(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/);

export function unique(values: readonly string[]): boolean {
  return values.every((value, index) => values.indexOf(value) === index);
}
