ALTER TABLE "game_versions" DROP CONSTRAINT "game_versions_build_hash_unique";--> statement-breakpoint
CREATE INDEX "game_versions_build_hash_idx" ON "game_versions" USING btree ("build_hash");--> statement-breakpoint
ALTER TABLE "match_seats" ADD CONSTRAINT "match_seats_match_user_unique" UNIQUE("match_id","user_id");--> statement-breakpoint
ALTER TABLE "game_versions" ADD CONSTRAINT "game_versions_ready_hash" CHECK (("game_versions"."status" = 'ready') = ("game_versions"."build_hash" IS NOT NULL));