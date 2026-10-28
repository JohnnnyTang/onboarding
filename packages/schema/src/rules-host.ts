import { z } from "zod";
import {
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

// Privileged server IPC. This version is independent of the browser wire protocol.
export const HOST_PROTOCOL_VERSION = 1;
export const HostMoveOutcomeSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), event: AcceptedEventSchema }),
  z.strictObject({
    ok: z.literal(false),
    code: RejectCodeSchema,
    message: z.string(),
    gameCode: z.string().optional(),
  }),
]);
export const HostViewsSchema = z.record(SeatIdSchema, ClientViewSchema);
export const HostBuildSchema = z.strictObject({
  entry: VersionPathSchema,
  files: z.record(VersionPathSchema, Sha256Schema),
  source: z.string().max(2 * 1024 * 1024),
});
export type HostBuild = z.infer<typeof HostBuildSchema>;
export const HostMatchInitSchema = MatchInitSchema.safeExtend({ buildHash: Sha256Schema });
export type HostMatchInit = z.infer<typeof HostMatchInitSchema>;
export const HostRequestSchema = z.strictObject({
  v: z.literal(HOST_PROTOCOL_VERSION),
  id: PositiveIntegerSchema,
  command: z.discriminatedUnion("op", [
    z.strictObject({
      op: z.literal("load"),
      source: z.string().max(2 * 1024 * 1024),
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
