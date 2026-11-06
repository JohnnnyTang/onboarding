import { z } from "zod";
import {
  GameCodeSchema,
  IdSchema,
  PositiveIntegerSchema,
  RejectCodeSchema,
  SeatIdSchema,
  Sha256Schema,
  VersionPathSchema,
} from "./common.js";
import {
  AcceptedEventSchema,
  ClientViewSchema,
  MatchInitSchema,
  MatchStateSchema,
  MoveIntentSchema,
} from "./rules.js";
import { ComponentsFileSchema } from "./table.js";

// Privileged server IPC. This version is independent of the browser wire protocol.
export const HOST_PROTOCOL_VERSION = 1;
export const HostMoveOutcomeSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), event: AcceptedEventSchema }),
  z
    .strictObject({
      ok: z.literal(false),
      code: RejectCodeSchema,
      message: z.string(),
      gameCode: GameCodeSchema.optional(),
    })
    .refine(
      (value) =>
        value.code !== "GAME_ERROR" ||
        (value.message === "Game execution failed" && value.gameCode === undefined),
      "Game errors must use the fixed safe payload",
    ),
]);
export const HostViewsSchema = z.record(SeatIdSchema, ClientViewSchema);
/** Largest game source (an enforced bundle or a sandbox components file) a host loads. */
export const MAX_HOST_SOURCE_BYTES = 2 * 1024 * 1024;
/**
 * An immutable build as the version store hands it to the host client. Enforced builds carry
 * the bundle named by `entry`; sandbox builds (T17) carry the components file named by
 * `components`, from which the host runs the built-in sandbox definition.
 */
export const HostBuildSchema = z.union([
  z.strictObject({
    entry: VersionPathSchema,
    files: z.record(VersionPathSchema, Sha256Schema),
    source: z.string().max(MAX_HOST_SOURCE_BYTES),
  }),
  z.strictObject({
    mode: z.literal("sandbox"),
    components: VersionPathSchema,
    files: z.record(VersionPathSchema, Sha256Schema),
    source: z.string().max(MAX_HOST_SOURCE_BYTES),
  }),
]);
export type HostBuild = z.infer<typeof HostBuildSchema>;
export const HostMatchInitSchema = MatchInitSchema.safeExtend({ buildHash: Sha256Schema });
export type HostMatchInit = z.infer<typeof HostMatchInitSchema>;
export const HostRequestSchema = z.strictObject({
  v: z.literal(HOST_PROTOCOL_VERSION),
  id: PositiveIntegerSchema,
  command: z.discriminatedUnion("op", [
    z.strictObject({ op: z.literal("prepare") }),
    z.strictObject({
      op: z.literal("load"),
      source: z.string().max(MAX_HOST_SOURCE_BYTES),
      timeoutMs: PositiveIntegerSchema.max(1000),
      memoryLimitBytes: PositiveIntegerSchema.max(64 * 1024 * 1024),
    }),
    z.strictObject({
      op: z.literal("loadSandbox"),
      components: ComponentsFileSchema,
      timeoutMs: PositiveIntegerSchema.max(1000),
      memoryLimitBytes: PositiveIntegerSchema.max(64 * 1024 * 1024),
    }),
    z.strictObject({ op: z.literal("create"), init: MatchInitSchema }),
    z.strictObject({ op: z.literal("apply"), seat: SeatIdSchema, intent: MoveIntentSchema }),
    z.strictObject({ op: z.literal("views") }),
    z.strictObject({ op: z.literal("hash") }),
    z.strictObject({ op: z.literal("exportState") }),
    z.strictObject({
      op: z.literal("restore"),
      snapshot: MatchStateSchema,
      events: z.array(AcceptedEventSchema),
    }),
    z.strictObject({ op: z.literal("dispose") }),
  ]),
});
export type HostCommand = z.infer<typeof HostRequestSchema>["command"];
export const HostResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    v: z.literal(HOST_PROTOCOL_VERSION),
    id: PositiveIntegerSchema,
    ok: z.literal(true),
    value: z.union([
      z.null(),
      Sha256Schema,
      HostMoveOutcomeSchema,
      HostViewsSchema,
      MatchStateSchema,
    ]),
  }),
  z.strictObject({
    v: z.literal(HOST_PROTOCOL_VERSION),
    id: PositiveIntegerSchema,
    ok: z.literal(false),
    code: z.literal("GAME_ERROR"),
    message: z.literal("Game execution failed"),
  }),
]);
export const HostMatchIdSchema = IdSchema.max(200);
