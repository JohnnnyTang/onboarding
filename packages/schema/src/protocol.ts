import { z } from "zod";
import {
  ErrorCodeSchema,
  GameCodeSchema,
  IdSchema,
  IsoTimeSchema,
  JsonSchema,
  MatchStatusSchema,
  NonnegativeIntegerSchema,
  PositionSchema,
  PositiveIntegerSchema,
  SeatIdSchema,
  Sha256Schema,
  unique,
} from "./common.js";
import { ClientViewSchema, GameResultSchema, MoveIntentSchema } from "./rules.js";

export const PROTOCOL_VERSION = 1;
export const SeatInfoSchema = z.strictObject({
  seat: SeatIdSchema,
  name: z.string(),
  connected: z.boolean(),
  guest: z.boolean(),
});
export type SeatInfo = z.infer<typeof SeatInfoSchema>;
export const SeatInfosSchema = z
  .array(SeatInfoSchema)
  .max(8)
  .refine((seats) => unique(seats.map((seat) => seat.seat)), "Duplicate seats");
export const EphemeralDataSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("drag"), item: IdSchema, pos_mm: PositionSchema }),
  z.strictObject({ kind: z.literal("pointer"), pos_mm: PositionSchema }),
]);
export type EphemeralData = z.infer<typeof EphemeralDataSchema>;
export const AuthSchema = z.strictObject({ kind: z.enum(["user", "guest"]), token: IdSchema });
export const HelloMessageSchema = z.strictObject({
  t: z.literal("hello"),
  protocol: z.literal(PROTOCOL_VERSION),
  matchId: IdSchema,
  auth: AuthSchema,
  lastSeq: NonnegativeIntegerSchema.optional(),
});
export const MoveMessageSchema = z.strictObject({
  t: z.literal("move"),
  clientSeq: NonnegativeIntegerSchema,
  intent: MoveIntentSchema,
});
export const ResyncMessageSchema = z.strictObject({ t: z.literal("resync") });
export const ClientEphemeralMessageSchema = z.strictObject({
  t: z.literal("ephemeral"),
  data: EphemeralDataSchema,
});
export const ChatTextSchema = z.string().min(1).max(500);
export const ClientChatMessageSchema = z.strictObject({
  t: z.literal("chat"),
  text: ChatTextSchema,
});
export const PingMessageSchema = z.strictObject({
  t: z.literal("ping"),
  ts: NonnegativeIntegerSchema,
});
export const ClientMessageSchema = z.discriminatedUnion("t", [
  HelloMessageSchema,
  MoveMessageSchema,
  ResyncMessageSchema,
  ClientEphemeralMessageSchema,
  ClientChatMessageSchema,
  PingMessageSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export const MatchSummarySchema = z.strictObject({
  id: IdSchema,
  status: MatchStatusSchema,
  versionId: IdSchema,
  buildHash: Sha256Schema,
  seats: SeatInfosSchema,
});
export type MatchSummary = z.infer<typeof MatchSummarySchema>;

export const JsonPointerSchema = z.string().regex(/^(?:\/(?:[^~/]|~[01])*)*$/);
export const JsonPatchOperationSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("add"), path: JsonPointerSchema, value: JsonSchema }),
  z.strictObject({ op: z.literal("remove"), path: JsonPointerSchema }),
  z.strictObject({ op: z.literal("replace"), path: JsonPointerSchema, value: JsonSchema }),
  z.strictObject({ op: z.literal("move"), path: JsonPointerSchema, from: JsonPointerSchema }),
  z.strictObject({ op: z.literal("copy"), path: JsonPointerSchema, from: JsonPointerSchema }),
  z.strictObject({ op: z.literal("test"), path: JsonPointerSchema, value: JsonSchema }),
]);
export type JsonPatchOperation = z.infer<typeof JsonPatchOperationSchema>;
export const WelcomeMessageSchema = z.strictObject({
  t: z.literal("welcome"),
  protocol: z.literal(PROTOCOL_VERSION),
  seat: SeatIdSchema.nullable(),
  match: MatchSummarySchema,
  seq: NonnegativeIntegerSchema,
  view: ClientViewSchema,
});
export const PatchMessageSchema = z.strictObject({
  t: z.literal("patch"),
  seq: PositiveIntegerSchema,
  ops: z.array(JsonPatchOperationSchema),
  cause: z.strictObject({
    seat: SeatIdSchema,
    clientSeq: NonnegativeIntegerSchema.optional(),
    move: IdSchema,
  }),
});
export const SnapshotMessageSchema = z.strictObject({
  t: z.literal("snapshot"),
  seq: NonnegativeIntegerSchema,
  view: ClientViewSchema,
});
export const RejectedMessageSchema = z.strictObject({
  t: z.literal("rejected"),
  clientSeq: NonnegativeIntegerSchema,
  code: ErrorCodeSchema,
  gameCode: GameCodeSchema.optional(),
  message: z.string(),
});
export const PresenceMessageSchema = z.strictObject({
  t: z.literal("presence"),
  seats: SeatInfosSchema,
});
export const ServerEphemeralMessageSchema = z.strictObject({
  t: z.literal("ephemeral"),
  from: SeatIdSchema,
  data: EphemeralDataSchema,
});
export const ServerChatMessageSchema = z.strictObject({
  t: z.literal("chat"),
  from: SeatIdSchema,
  name: z.string(),
  text: ChatTextSchema,
  at: IsoTimeSchema,
});
export const EndedMessageSchema = z.strictObject({
  t: z.literal("ended"),
  result: GameResultSchema,
});
export const ErrorMessageSchema = z.strictObject({
  t: z.literal("error"),
  code: ErrorCodeSchema,
  message: z.string(),
  fatal: z.boolean(),
});
export const PongMessageSchema = z.strictObject({
  t: z.literal("pong"),
  ts: NonnegativeIntegerSchema,
});
export const ServerMessageSchema = z.discriminatedUnion("t", [
  WelcomeMessageSchema,
  PatchMessageSchema,
  SnapshotMessageSchema,
  RejectedMessageSchema,
  PresenceMessageSchema,
  ServerEphemeralMessageSchema,
  ServerChatMessageSchema,
  EndedMessageSchema,
  ErrorMessageSchema,
  PongMessageSchema,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type HelloMessage = z.infer<typeof HelloMessageSchema>;
export type MoveMessage = z.infer<typeof MoveMessageSchema>;
export type ResyncMessage = z.infer<typeof ResyncMessageSchema>;
export type ClientEphemeralMessage = z.infer<typeof ClientEphemeralMessageSchema>;
export type ClientChatMessage = z.infer<typeof ClientChatMessageSchema>;
export type PingMessage = z.infer<typeof PingMessageSchema>;
export type WelcomeMessage = z.infer<typeof WelcomeMessageSchema>;
export type PatchMessage = z.infer<typeof PatchMessageSchema>;
export type SnapshotMessage = z.infer<typeof SnapshotMessageSchema>;
export type RejectedMessage = z.infer<typeof RejectedMessageSchema>;
export type PresenceMessage = z.infer<typeof PresenceMessageSchema>;
export type ServerEphemeralMessage = z.infer<typeof ServerEphemeralMessageSchema>;
export type ServerChatMessage = z.infer<typeof ServerChatMessageSchema>;
export type EndedMessage = z.infer<typeof EndedMessageSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
export type PongMessage = z.infer<typeof PongMessageSchema>;
