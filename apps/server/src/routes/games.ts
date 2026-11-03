import {
  CreateGameBodySchema,
  CreateVersionBodySchema,
  GameDetailResponseSchema,
  GameListResponseSchema,
  GameResponseSchema,
  UpdateGameBodySchema,
} from "@bgp/schema";
import { and, asc, desc, eq, lt } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import type { AppDependencies } from "../app.js";
import { createId } from "../db/id.js";
import { games, gameVersions } from "../db/schema.js";
import { currentUser, type GameRow, listQuery, ownedGame, page } from "../http/access.js";
import { conflict, parseRequest, validationFailed } from "../http/errors.js";
import { versionResponse } from "./versions.js";

export function gameResponse(game: GameRow) {
  // Phase 1 rejects `public` on write, so stored rows are private or unlisted.
  return GameResponseSchema.parse({
    id: game.id,
    slug: game.slug,
    name: game.name,
    visibility: game.visibility,
  });
}

export function isUniqueViolation(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "23505";
}

export const gameRoutes: FastifyPluginAsync<AppDependencies> = async (app, { db }) => {
  app.get("/api/games", async (request) => {
    const user = currentUser(request);
    const { limit, cursor } = listQuery(request.query);
    const rows = await db
      .select()
      .from(games)
      .where(and(eq(games.ownerId, user.id), cursor ? lt(games.id, cursor) : undefined))
      .orderBy(desc(games.id))
      .limit(limit + 1);
    const result = page(rows, limit);
    return GameListResponseSchema.parse({ ...result, items: result.items.map(gameResponse) });
  });

  app.post("/api/games", async (request, reply) => {
    const user = currentUser(request);
    const body = parseRequest(CreateGameBodySchema, request.body);
    try {
      const [game] = await db.transaction((tx) =>
        tx
          .insert(games)
          .values({ id: createId(), ownerId: user.id, ...body })
          .returning(),
      );
      if (!game) throw new Error("Insert returned no game");
      return reply.code(201).send(gameResponse(game));
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("A game with this slug already exists");
      throw error;
    }
  });

  app.get("/api/games/:gameId", async (request) => {
    const game = await ownedGame(
      db,
      (request.params as { gameId: unknown }).gameId,
      currentUser(request),
    );
    const versions = await db
      .select()
      .from(gameVersions)
      .where(eq(gameVersions.gameId, game.id))
      .orderBy(asc(gameVersions.id));
    return GameDetailResponseSchema.parse({
      ...gameResponse(game),
      versions: versions.map(versionResponse),
    });
  });

  app.patch("/api/games/:gameId", async (request) => {
    const user = currentUser(request);
    const game = await ownedGame(db, (request.params as { gameId: unknown }).gameId, user);
    const body = parseRequest(UpdateGameBodySchema, request.body);
    const [updated] = await db
      .update(games)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(games.id, game.id))
      .returning();
    if (!updated) throw new Error("Update returned no game");
    return gameResponse(updated);
  });

  app.post("/api/games/:gameId/versions", async (request, reply) => {
    const user = currentUser(request);
    const game = await ownedGame(db, (request.params as { gameId: unknown }).gameId, user);
    const manifest = parseRequest(CreateVersionBodySchema, request.body, "VALIDATION_FAILED");
    if (manifest.id !== game.slug) {
      throw validationFailed("Validation failed", [
        { path: "id", message: `Manifest id must equal the game slug ${game.slug}` },
      ]);
    }
    try {
      const [version] = await db.transaction((tx) =>
        tx
          .insert(gameVersions)
          .values({
            id: createId(),
            gameId: game.id,
            version: manifest.version,
            mode: manifest.mode,
            status: "draft",
            manifest,
          })
          .returning(),
      );
      if (!version) throw new Error("Insert returned no version");
      return reply.code(201).send(versionResponse(version));
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("This game already has that version");
      throw error;
    }
  });
};
