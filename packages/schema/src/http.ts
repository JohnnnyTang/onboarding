import { z } from "zod";
import {
  ErrorCodeSchema,
  IdSchema,
  IsoTimeSchema,
  JsonSchema,
  NonnegativeIntegerSchema,
  SeatIdSchema,
  Sha256Schema,
  SlugSchema,
  Uint32Schema,
  VersionPathSchema,
  VisibilitySchema,
} from "./common.js";
import { ManifestSchema } from "./manifest.js";
import { MatchSummarySchema } from "./protocol.js";
import { AcceptedEventSchema, SeatsSchema } from "./rules.js";

export const ValidationErrorSchema = z.strictObject({ path: z.string(), message: z.string() });
export type ValidationError = z.infer<typeof ValidationErrorSchema>;
export const HttpErrorSchema = z.strictObject({
  error: z.strictObject({
    code: ErrorCodeSchema,
    message: z.string(),
    errors: z.array(ValidationErrorSchema).optional(),
  }),
});
export type HttpError = z.infer<typeof HttpErrorSchema>;
export const CreateGameBodySchema = z.strictObject({
  slug: SlugSchema,
  name: z.string().min(1).max(80),
  visibility: VisibilitySchema,
});
export type CreateGameBody = z.infer<typeof CreateGameBodySchema>;
export const UpdateGameBodySchema = z
  .strictObject({
    name: z.string().min(1).max(80).optional(),
    visibility: VisibilitySchema.optional(),
  })
  .refine(
    (body) => body.name !== undefined || body.visibility !== undefined,
    "At least one change is required",
  );
export type UpdateGameBody = z.infer<typeof UpdateGameBodySchema>;
export const CreateVersionBodySchema = ManifestSchema;
export type CreateVersionBody = z.infer<typeof CreateVersionBodySchema>;
export const CreateMatchBodySchema = z.strictObject({
  versionId: IdSchema,
  seatCount: z.int().min(1).max(8),
  options: JsonSchema,
});
export type CreateMatchBody = z.infer<typeof CreateMatchBodySchema>;
export const ClaimInviteBodySchema = z.strictObject({ displayName: z.string().min(1).max(80) });
export type ClaimInviteBody = z.infer<typeof ClaimInviteBodySchema>;
export const ClaimInviteResponseSchema = z.strictObject({
  matchId: IdSchema,
  seat: SeatIdSchema,
  guestToken: IdSchema.optional(),
});
export type ClaimInviteResponse = z.infer<typeof ClaimInviteResponseSchema>;
export const FeedbackBodySchema = z.strictObject({
  seq: NonnegativeIntegerSchema,
  body: z.string().min(1).max(2000),
});
export type FeedbackBody = z.infer<typeof FeedbackBodySchema>;
export const ReplayResponseSchema = z.strictObject({
  buildHash: Sha256Schema,
  seats: SeatsSchema,
  seed: Uint32Schema,
  options: JsonSchema,
  events: z.array(AcceptedEventSchema),
});
export type ReplayResponse = z.infer<typeof ReplayResponseSchema>;
export const ListQuerySchema = z.strictObject({
  limit: z.int().min(1).max(200).optional(),
  cursor: IdSchema.optional(),
});
export type ListQuery = z.infer<typeof ListQuerySchema>;
export const UploadHeadersSchema = z.object({ "x-content-sha256": Sha256Schema });
export type UploadHeaders = z.infer<typeof UploadHeadersSchema>;
export const FileParamsSchema = z.strictObject({
  versionId: IdSchema,
  path: VersionPathSchema.refine(
    (path) => !/\.wasm$/i.test(path),
    "Game WASM is not allowed in Phase 1",
  ),
});
export const EmptyBodySchema = z.strictObject({});
export type FileParams = z.infer<typeof FileParamsSchema>;
export const HealthResponseSchema = z.strictObject({ ok: z.literal(true) });
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export const UserResponseSchema = z.strictObject({
  id: IdSchema,
  displayName: z.string(),
  email: z.string().nullable(),
});
export type UserResponse = z.infer<typeof UserResponseSchema>;
export const GameResponseSchema = z.strictObject({
  id: IdSchema,
  slug: SlugSchema,
  name: z.string().min(1).max(80),
  visibility: VisibilitySchema,
});
export type GameResponse = z.infer<typeof GameResponseSchema>;
export const VersionResponseSchema = z
  .strictObject({
    id: IdSchema,
    gameId: IdSchema,
    manifest: ManifestSchema,
    status: z.enum(["draft", "ready", "failed"]),
    buildHash: Sha256Schema.nullable(),
    validationErrors: z.array(ValidationErrorSchema).nullable(),
  })
  .refine(
    (version) => version.status !== "ready" || version.buildHash !== null,
    "Ready versions require a build hash",
  );
export type VersionResponse = z.infer<typeof VersionResponseSchema>;
export const GameDetailResponseSchema = GameResponseSchema.extend({
  versions: z.array(VersionResponseSchema),
});
export type GameDetailResponse = z.infer<typeof GameDetailResponseSchema>;
export const GameListResponseSchema = z.strictObject({
  items: z.array(GameResponseSchema),
  cursor: IdSchema.nullable(),
});
export const MatchListResponseSchema = z.strictObject({
  items: z.array(MatchSummarySchema),
  cursor: IdSchema.nullable(),
});
export type GameListResponse = z.infer<typeof GameListResponseSchema>;
export type MatchListResponse = z.infer<typeof MatchListResponseSchema>;
export const CreateMatchResponseSchema = z.strictObject({
  match: MatchSummarySchema,
  invites: z
    .array(z.strictObject({ seat: SeatIdSchema, url: z.string().min(1) }))
    .min(1)
    .max(8),
});
export type CreateMatchResponse = z.infer<typeof CreateMatchResponseSchema>;
export const FinalizeResponseSchema = z.strictObject({ buildHash: Sha256Schema });
export type FinalizeResponse = z.infer<typeof FinalizeResponseSchema>;
export const FeedbackResponseSchema = z.strictObject({
  id: IdSchema,
  seq: NonnegativeIntegerSchema,
  body: z.string().min(1).max(2000),
  createdAt: IsoTimeSchema,
});
export type FeedbackResponse = z.infer<typeof FeedbackResponseSchema>;

// Raw uploads/downloads have no JSON body. Empty action bodies may be omitted by HTTP adapters.
export const HTTP_CONTRACTS = {
  "GET /api/healthz": { response: HealthResponseSchema },
  "GET /api/me": { response: UserResponseSchema },
  "GET /api/games": { query: ListQuerySchema, response: GameListResponseSchema },
  "POST /api/games": { body: CreateGameBodySchema, response: GameResponseSchema },
  "GET /api/games/:gameId": { response: GameDetailResponseSchema },
  "PATCH /api/games/:gameId": { body: UpdateGameBodySchema, response: GameResponseSchema },
  "POST /api/games/:gameId/versions": {
    body: CreateVersionBodySchema,
    response: VersionResponseSchema,
  },
  "PUT /api/versions/:versionId/files/*": {
    headers: UploadHeadersSchema,
    params: FileParamsSchema,
  },
  "POST /api/versions/:versionId/finalize": {
    body: EmptyBodySchema,
    response: FinalizeResponseSchema,
  },
  "GET /api/versions/:versionId/files/*": { params: FileParamsSchema },
  "POST /api/matches": { body: CreateMatchBodySchema, response: CreateMatchResponseSchema },
  "GET /api/matches": { query: ListQuerySchema, response: MatchListResponseSchema },
  "GET /api/matches/:matchId": { response: MatchSummarySchema },
  "POST /api/matches/:matchId/start": { body: EmptyBodySchema, response: MatchSummarySchema },
  "POST /api/matches/:matchId/abandon": { body: EmptyBodySchema, response: MatchSummarySchema },
  "POST /api/invites/:token/claim": {
    body: ClaimInviteBodySchema,
    response: ClaimInviteResponseSchema,
  },
  "GET /api/matches/:matchId/replay": { response: ReplayResponseSchema },
  "POST /api/matches/:matchId/feedback": {
    body: FeedbackBodySchema,
    response: FeedbackResponseSchema,
  },
} as const;
