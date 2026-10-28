import { HttpErrorSchema, IdSchema } from "@bgp/schema";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { AuthError, type AuthService, type CallerIdentity, requireMatchScope } from "./service.js";

export type AuthPolicy = "none" | "optional" | "user" | "match";
declare module "fastify" {
  interface FastifyRequest {
    identity: CallerIdentity | null;
  }
  interface FastifyContextConfig {
    auth?: AuthPolicy;
  }
}

function routeMatchId(request: FastifyRequest): string {
  const params = request.params;
  if (typeof params !== "object" || params === null || !("matchId" in params)) {
    throw new Error("A match auth route requires a matchId parameter");
  }
  const parsed = IdSchema.safeParse(params.matchId);
  if (!parsed.success) throw new AuthError("FORBIDDEN");
  return parsed.data;
}

const installAuth: FastifyPluginAsync<{ auth: AuthService }> = async (app, { auth }) => {
  app.decorateRequest("identity", null);
  app.addHook("onRequest", async (request, reply) => {
    const policy = request.routeOptions.config.auth ?? "user";
    if (policy === "none") return;
    if (policy === "optional" && request.headers.authorization === undefined) return;
    try {
      const identity = await auth.authenticate(request.headers.authorization);
      if ((policy === "user" || policy === "optional") && identity.kind !== "user") {
        throw new AuthError("FORBIDDEN");
      }
      if (policy === "match") requireMatchScope(identity, routeMatchId(request));
      request.identity = identity;
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      return reply
        .code(error.code === "UNAUTHORIZED" ? 401 : 403)
        .send(HttpErrorSchema.parse({ error: { code: error.code, message: error.message } }));
    }
  });
};

export const authPlugin = fp(installAuth, { name: "bgp-auth", fastify: "5.x" });
