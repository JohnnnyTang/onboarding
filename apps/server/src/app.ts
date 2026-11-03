import { HealthResponseSchema, UserResponseSchema } from "@bgp/schema";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import { authPlugin } from "./auth/plugin.js";
import type { AuthService } from "./auth/service.js";
import type { BlobStore } from "./blob/blob-store.js";
import type { Database } from "./db/connection.js";
import { ApiError, sendError } from "./http/errors.js";
import type { RoomManager } from "./room/manager.js";
import { roomRoutes } from "./room/routes.js";
import { gameRoutes } from "./routes/games.js";
import { matchRoutes } from "./routes/matches.js";
import { versionRoutes } from "./routes/versions.js";
import type { SetupChecker } from "./versions/finalize.js";

export interface AppDependencies {
  db: Database;
  auth: AuthService;
  blobs: BlobStore;
  setup: SetupChecker;
  /** Allowed CORS origin and base of invite links. */
  publicWebOrigin: string;
  logger?: FastifyServerOptions["logger"];
  /** The WebSocket room server (`/ws`); without it only the HTTP API is served. */
  rooms?: RoomManager;
  /** Room `hello` deadline; defaults to the protocol's 10 seconds. */
  helloTimeoutMs?: number;
}

const CORS_HEADERS = {
  "access-control-allow-methods": "GET, POST, PUT, PATCH, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, x-content-sha256",
  "access-control-max-age": "600",
};

function isFastifyError(error: unknown): error is FastifyError {
  return error instanceof Error && "code" in error;
}

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 1024 * 1024 });

  // Bearer tokens only (D-007): no cookies, so CORS never allows credentials.
  app.addHook("onRequest", async (request, reply) => {
    if (request.headers.origin === deps.publicWebOrigin) {
      reply.header("access-control-allow-origin", deps.publicWebOrigin);
      reply.header("vary", "Origin");
      if (request.method === "OPTIONS") reply.headers(CORS_HEADERS);
    }
  });
  app.options("/api/*", { config: { auth: "none" } }, async (_request, reply) =>
    reply.code(204).send(),
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) return sendError(reply, error);
    if (isFastifyError(error) && error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return sendError(reply, new ApiError(413, "VALIDATION_FAILED", "Request body too large"));
    }
    if (isFastifyError(error) && error.statusCode !== undefined && error.statusCode < 500) {
      return sendError(reply, new ApiError(400, "BAD_MESSAGE", "Malformed request"));
    }
    request.log.error({ err: error }, "request failed");
    return sendError(reply, new ApiError(500, "INTERNAL", "Internal server error"));
  });
  app.setNotFoundHandler((_request, reply) =>
    sendError(reply, new ApiError(404, "NOT_FOUND", "Route not found")),
  );

  await app.register(authPlugin, { auth: deps.auth });
  app.get("/api/healthz", { config: { auth: "none" } }, async () =>
    HealthResponseSchema.parse({ ok: true }),
  );
  app.get("/api/me", async (request) => {
    if (request.identity?.kind !== "user") throw new Error("User route without a user");
    return UserResponseSchema.parse(request.identity.user);
  });
  await app.register(gameRoutes, deps);
  await app.register(versionRoutes, deps);
  await app.register(matchRoutes, deps);
  if (deps.rooms) {
    await app.register(roomRoutes, {
      db: deps.db,
      auth: deps.auth,
      rooms: deps.rooms,
      ...(deps.helloTimeoutMs === undefined ? {} : { helloTimeoutMs: deps.helloTimeoutMs }),
    });
  }
  return app;
}
