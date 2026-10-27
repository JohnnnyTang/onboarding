CREATE TYPE "public"."game_mode" AS ENUM('enforced', 'sandbox');--> statement-breakpoint
CREATE TYPE "public"."game_visibility" AS ENUM('private', 'unlisted', 'public');--> statement-breakpoint
CREATE TYPE "public"."match_status" AS ENUM('lobby', 'active', 'finished', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."version_status" AS ENUM('draft', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "game_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"game_id" uuid NOT NULL,
	"version" text NOT NULL,
	"mode" "game_mode" NOT NULL,
	"status" "version_status" NOT NULL,
	"manifest" jsonb NOT NULL,
	"build_hash" text,
	"validation_errors" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "game_versions_build_hash_unique" UNIQUE("build_hash"),
	CONSTRAINT "game_versions_game_version_unique" UNIQUE("game_id","version")
);
--> statement-breakpoint
CREATE TABLE "games" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"visibility" "game_visibility" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "games_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "match_events" (
	"match_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"seat" text NOT NULL,
	"intent" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_events_match_id_seq_pk" PRIMARY KEY("match_id","seq"),
	CONSTRAINT "match_events_seq_positive" CHECK ("match_events"."seq" > 0),
	CONSTRAINT "match_events_seat_format" CHECK ("match_events"."seat" ~ '^(0|[1-9][0-9]*)$')
);
--> statement-breakpoint
CREATE TABLE "match_feedback" (
	"id" uuid PRIMARY KEY NOT NULL,
	"match_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"seat" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_feedback_seq_nonnegative" CHECK ("match_feedback"."seq" >= 0),
	CONSTRAINT "match_feedback_seat_format" CHECK ("match_feedback"."seat" ~ '^(0|[1-9][0-9]*)$'),
	CONSTRAINT "match_feedback_body_length" CHECK (char_length("match_feedback"."body") BETWEEN 1 AND 2000)
);
--> statement-breakpoint
CREATE TABLE "match_seats" (
	"match_id" uuid NOT NULL,
	"seat" text NOT NULL,
	"user_id" uuid,
	"display_name" text,
	"is_guest" boolean NOT NULL,
	"invite_token_hash" text NOT NULL,
	"claimed_at" timestamp with time zone,
	CONSTRAINT "match_seats_match_id_seat_pk" PRIMARY KEY("match_id","seat"),
	CONSTRAINT "match_seats_invite_token_hash_unique" UNIQUE("invite_token_hash"),
	CONSTRAINT "match_seats_seat_format" CHECK ("match_seats"."seat" ~ '^(0|[1-9][0-9]*)$')
);
--> statement-breakpoint
CREATE TABLE "match_snapshots" (
	"match_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"state" jsonb NOT NULL,
	"state_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_snapshots_match_id_seq_pk" PRIMARY KEY("match_id","seq"),
	CONSTRAINT "match_snapshots_seq_nonnegative" CHECK ("match_snapshots"."seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"status" "match_status" NOT NULL,
	"seat_count" integer NOT NULL,
	"seed" bigint NOT NULL,
	"options" jsonb NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "matches_seed_uint32" CHECK ("matches"."seed" BETWEEN 0 AND 4294967295),
	CONSTRAINT "matches_seat_count_range" CHECK ("matches"."seat_count" BETWEEN 1 AND 8),
	CONSTRAINT "matches_last_seq_nonnegative" CHECK ("matches"."last_seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"oidc_issuer" text NOT NULL,
	"oidc_subject" text NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_oidc_identity_unique" UNIQUE("oidc_issuer","oidc_subject")
);
--> statement-breakpoint
CREATE TABLE "version_files" (
	"version_id" uuid NOT NULL,
	"path" text NOT NULL,
	"sha256" text NOT NULL,
	"bytes" integer NOT NULL,
	"content_type" text NOT NULL,
	CONSTRAINT "version_files_version_id_path_pk" PRIMARY KEY("version_id","path"),
	CONSTRAINT "version_files_bytes_nonnegative" CHECK ("version_files"."bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "game_versions" ADD CONSTRAINT "game_versions_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_feedback" ADD CONSTRAINT "match_feedback_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_seats" ADD CONSTRAINT "match_seats_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_seats" ADD CONSTRAINT "match_seats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_snapshots" ADD CONSTRAINT "match_snapshots_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_version_id_game_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."game_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_files" ADD CONSTRAINT "version_files_version_id_game_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."game_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "games_owner_id_idx" ON "games" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "match_feedback_match_id_idx" ON "match_feedback" USING btree ("match_id");--> statement-breakpoint
CREATE INDEX "match_seats_user_id_idx" ON "match_seats" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "matches_created_by_idx" ON "matches" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "matches_version_id_idx" ON "matches" USING btree ("version_id");