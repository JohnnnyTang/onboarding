import type {
  GameResult,
  Json,
  Manifest,
  MatchState,
  MoveIntent,
  ValidationError,
} from "@bgp/schema";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const gameVisibility = pgEnum("game_visibility", ["private", "unlisted", "public"]);
export const gameMode = pgEnum("game_mode", ["enforced", "sandbox"]);
export const versionStatus = pgEnum("version_status", ["draft", "ready", "failed"]);
export const matchStatus = pgEnum("match_status", ["lobby", "active", "finished", "abandoned"]);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// UUID v7 values are supplied by the application, not database-generated v4 defaults.
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    oidcIssuer: text("oidc_issuer").notNull(),
    oidcSubject: text("oidc_subject").notNull(),
    displayName: text("display_name").notNull(),
    email: text("email"),
    createdAt: createdAt(),
  },
  (table) => [unique("users_oidc_identity_unique").on(table.oidcIssuer, table.oidcSubject)],
);

export const games = pgTable(
  "games",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    visibility: gameVisibility("visibility").notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("games_owner_id_idx").on(table.ownerId)],
);

export const gameVersions = pgTable(
  "game_versions",
  {
    id: uuid("id").primaryKey(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id),
    version: text("version").notNull(),
    mode: gameMode("mode").notNull(),
    status: versionStatus("status").notNull(),
    manifest: jsonb("manifest").$type<Manifest>().notNull(),
    buildHash: text("build_hash").unique(),
    validationErrors: jsonb("validation_errors").$type<ValidationError[]>(),
    createdAt: createdAt(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  },
  (table) => [unique("game_versions_game_version_unique").on(table.gameId, table.version)],
);

export const versionFiles = pgTable(
  "version_files",
  {
    versionId: uuid("version_id")
      .notNull()
      .references(() => gameVersions.id),
    path: text("path").notNull(),
    sha256: text("sha256").notNull(),
    bytes: integer("bytes").notNull(),
    contentType: text("content_type").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.versionId, table.path] }),
    check("version_files_bytes_nonnegative", sql`${table.bytes} >= 0`),
  ],
);

export const matches = pgTable(
  "matches",
  {
    id: uuid("id").primaryKey(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => gameVersions.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    status: matchStatus("status").notNull(),
    seatCount: integer("seat_count").notNull(),
    seed: bigint("seed", { mode: "number" }).notNull(),
    options: jsonb("options").$type<Json>().notNull(),
    lastSeq: integer("last_seq").notNull().default(0),
    result: jsonb("result").$type<GameResult>(),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("matches_created_by_idx").on(table.createdBy),
    index("matches_version_id_idx").on(table.versionId),
    check("matches_seed_uint32", sql`${table.seed} BETWEEN 0 AND 4294967295`),
    check("matches_seat_count_range", sql`${table.seatCount} BETWEEN 1 AND 8`),
    check("matches_last_seq_nonnegative", sql`${table.lastSeq} >= 0`),
  ],
);

export const matchSeats = pgTable(
  "match_seats",
  {
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id),
    seat: text("seat").notNull(),
    userId: uuid("user_id").references(() => users.id),
    displayName: text("display_name"),
    isGuest: boolean("is_guest").notNull(),
    inviteTokenHash: text("invite_token_hash").notNull().unique(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.matchId, table.seat] }),
    index("match_seats_user_id_idx").on(table.userId),
    check("match_seats_seat_format", sql`${table.seat} ~ '^(0|[1-9][0-9]*)$'`),
  ],
);

export const matchEvents = pgTable(
  "match_events",
  {
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id),
    seq: integer("seq").notNull(),
    seat: text("seat").notNull(),
    intent: jsonb("intent").$type<MoveIntent>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.matchId, table.seq] }),
    check("match_events_seq_positive", sql`${table.seq} > 0`),
    check("match_events_seat_format", sql`${table.seat} ~ '^(0|[1-9][0-9]*)$'`),
  ],
);

export const matchSnapshots = pgTable(
  "match_snapshots",
  {
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id),
    seq: integer("seq").notNull(),
    state: jsonb("state").$type<MatchState>().notNull(),
    stateHash: text("state_hash").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.matchId, table.seq] }),
    check("match_snapshots_seq_nonnegative", sql`${table.seq} >= 0`),
  ],
);

// Storage only; the feedback UI remains a Phase 1 stretch goal.
export const matchFeedback = pgTable(
  "match_feedback",
  {
    id: uuid("id").primaryKey(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id),
    seq: integer("seq").notNull(),
    seat: text("seat").notNull(),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("match_feedback_match_id_idx").on(table.matchId),
    check("match_feedback_seq_nonnegative", sql`${table.seq} >= 0`),
    check("match_feedback_seat_format", sql`${table.seat} ~ '^(0|[1-9][0-9]*)$'`),
    check("match_feedback_body_length", sql`char_length(${table.body}) BETWEEN 1 AND 2000`),
  ],
);
