import { ListQuerySchema, type UserResponse } from "@bgp/schema";
import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { Database } from "../db/connection.js";
import { games, gameVersions } from "../db/schema.js";
import { ApiError, forbidden, notFound, parseRequest, resourceId } from "./errors.js";

export function currentUser(request: FastifyRequest): UserResponse {
  // The auth hook guarantees this on user routes; reaching here otherwise is a bug.
  if (request.identity?.kind !== "user") throw new Error("User route without a user identity");
  return request.identity.user;
}

export type GameRow = typeof games.$inferSelect;
export type VersionRow = typeof gameVersions.$inferSelect;

export async function ownedGame(
  db: Database,
  gameId: unknown,
  user: UserResponse,
): Promise<GameRow> {
  const [game] = await db
    .select()
    .from(games)
    .where(eq(games.id, resourceId(gameId, "Game")));
  if (!game) throw notFound("Game");
  if (game.ownerId !== user.id) throw forbidden();
  return game;
}

/** With `lock`, the version row stays locked until the caller's transaction ends. */
export async function ownedVersion(
  db: Database,
  versionId: unknown,
  user: UserResponse,
  lock = false,
): Promise<{ version: VersionRow; game: GameRow }> {
  const query = db
    .select()
    .from(gameVersions)
    .where(eq(gameVersions.id, resourceId(versionId, "Version")));
  const [version] = lock ? await query.for("update") : await query;
  if (!version) throw notFound("Version");
  const [game] = await db.select().from(games).where(eq(games.id, version.gameId));
  if (!game) throw notFound("Version");
  if (game.ownerId !== user.id) throw forbidden();
  return { version, game };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Decodes `?limit` and `?cursor`; cursors are the last ID of the previous page. */
export function listQuery(query: unknown): { limit: number; cursor: string | undefined } {
  const raw = typeof query === "object" && query !== null ? { ...query } : {};
  if ("limit" in raw && typeof raw.limit === "string" && /^\d{1,4}$/.test(raw.limit)) {
    raw.limit = Number(raw.limit);
  }
  const parsed = parseRequest(ListQuerySchema, raw);
  if (parsed.cursor !== undefined && !UUID.test(parsed.cursor)) {
    throw new ApiError(400, "BAD_MESSAGE", "Invalid request", [
      { path: "cursor", message: "Unknown cursor" },
    ]);
  }
  return { limit: parsed.limit ?? 50, cursor: parsed.cursor };
}

/** Pages are newest first; UUID v7 IDs sort by creation time. */
export function page<T extends { id: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, cursor: rows.length > limit && last ? last.id : null };
}
