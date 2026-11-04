import {
  EmptyBodySchema,
  FileParamsSchema,
  FinalizeResponseSchema,
  UploadHeadersSchema,
  type ValidationError,
  VersionResponseSchema,
} from "@bgp/schema";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { AppDependencies } from "../app.js";
import { blobKey } from "../blob/blob-store.js";
import type { Database } from "../db/connection.js";
import { games, gameVersions, matches, matchSeats, versionFiles } from "../db/schema.js";
import { currentUser, ownedVersion, type VersionRow } from "../http/access.js";
import {
  conflict,
  forbidden,
  notFound,
  parseRequest,
  resourceId,
  validationFailed,
} from "../http/errors.js";
import {
  checkUploadedFile,
  contentTypeFor,
  MAX_FILE_BYTES,
  MAX_VERSION_BYTES,
  MAX_VERSION_FILES,
  sha256Hex,
} from "../versions/files.js";
import { type FinalizeResult, validateVersion } from "../versions/finalize.js";

export function versionResponse(version: VersionRow) {
  return VersionResponseSchema.parse({
    id: version.id,
    gameId: version.gameId,
    manifest: version.manifest,
    status: version.status,
    buildHash: version.buildHash,
    validationErrors: version.validationErrors,
  });
}

function fileParams(request: FastifyRequest, onInvalid: (errors: ValidationError[]) => Error) {
  const params = request.params as Record<string, unknown>;
  const versionId = resourceId(params.versionId, "Version");
  const path = typeof params["*"] === "string" ? params["*"] : "";
  const parsed = FileParamsSchema.safeParse({ versionId, path });
  if (!parsed.success) {
    throw onInvalid(parsed.error.issues.map((issue) => ({ path, message: issue.message })));
  }
  return parsed.data;
}

/** Owners, and seat holders of matches pinned to this version, may download its files. */
async function canDownload(db: Database, request: FastifyRequest, version: VersionRow) {
  const identity = request.identity;
  if (!identity) return false;
  if (identity.kind === "user") {
    const [seatHolder] = await db
      .select({ id: gameVersions.id })
      .from(gameVersions)
      .innerJoin(matches, eq(matches.versionId, gameVersions.id))
      .innerJoin(matchSeats, eq(matchSeats.matchId, matches.id))
      .where(and(eq(gameVersions.id, version.id), eq(matchSeats.userId, identity.user.id)))
      .limit(1);
    if (seatHolder) return true;
    const [game] = await db
      .select({ ownerId: games.ownerId })
      .from(games)
      .where(eq(games.id, version.gameId));
    return game?.ownerId === identity.user.id;
  }
  const [seat] = await db
    .select({ seat: matchSeats.seat })
    .from(matchSeats)
    .innerJoin(matches, eq(matches.id, matchSeats.matchId))
    .where(
      and(
        eq(matchSeats.matchId, identity.matchId),
        eq(matchSeats.seat, identity.seat),
        eq(matchSeats.isGuest, true),
        isNotNull(matchSeats.claimedAt),
        eq(matches.versionId, version.id),
      ),
    );
  return seat !== undefined;
}

export const versionRoutes: FastifyPluginAsync<AppDependencies> = async (app, deps) => {
  const { db, blobs, setup } = deps;

  // Raw uploads get their own scope: every content type, JSON included, arrives as bytes.
  await app.register(async (raw) => {
    raw.removeAllContentTypeParsers();
    raw.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) =>
      done(null, body),
    );
    raw.put(
      "/api/versions/:versionId/files/*",
      { bodyLimit: MAX_FILE_BYTES },
      async (request, reply) => {
        const user = currentUser(request);
        const { versionId, path } = fileParams(request, (errors) =>
          validationFailed("Invalid file path", errors),
        );
        const headers = UploadHeadersSchema.safeParse({
          "x-content-sha256": request.headers["x-content-sha256"],
        });
        if (!headers.success) {
          throw validationFailed("Invalid upload", [
            { path, message: "x-content-sha256 must be a lowercase hex SHA-256" },
          ]);
        }
        const bytes = request.body instanceof Uint8Array ? request.body : new Uint8Array();
        const sha256 = sha256Hex(bytes);
        await db.transaction(async (tx) => {
          const { version } = await ownedVersion(tx, versionId, user, true);
          if (version.status === "ready") throw conflict("Ready versions are immutable");
          const errors: ValidationError[] = [];
          if (sha256 !== headers.data["x-content-sha256"]) {
            errors.push({ path, message: "Content does not match x-content-sha256" });
          }
          errors.push(...checkUploadedFile(path, bytes, version.manifest));
          const others = (
            await tx
              .select({ path: versionFiles.path, bytes: versionFiles.bytes })
              .from(versionFiles)
              .where(eq(versionFiles.versionId, versionId))
          ).filter((file) => file.path !== path);
          if (others.length + 1 > MAX_VERSION_FILES) {
            errors.push({
              path,
              message: `A version may contain at most ${MAX_VERSION_FILES} files`,
            });
          }
          if (
            others.reduce((sum, file) => sum + file.bytes, bytes.byteLength) > MAX_VERSION_BYTES
          ) {
            errors.push({ path, message: "A version may contain at most 100 MB" });
          }
          if (errors.length > 0) throw validationFailed("Upload rejected", errors);
          await blobs.put(blobKey(sha256), bytes);
          const row = { sha256, bytes: bytes.byteLength, contentType: contentTypeFor(path) };
          await tx
            .insert(versionFiles)
            .values({ versionId, path, ...row })
            .onConflictDoUpdate({ target: [versionFiles.versionId, versionFiles.path], set: row });
          if (version.status === "failed") {
            await tx
              .update(gameVersions)
              .set({ status: "draft", validationErrors: null })
              .where(eq(gameVersions.id, versionId));
          }
        });
        return reply.code(204).send();
      },
    );
  });

  app.post("/api/versions/:versionId/finalize", async (request) => {
    const user = currentUser(request);
    parseRequest(EmptyBodySchema, request.body ?? {});
    const versionId = resourceId((request.params as { versionId: unknown }).versionId, "Version");
    // The row lock serializes finalize with uploads and other finalize calls.
    const result = await db.transaction(async (tx): Promise<FinalizeResult> => {
      const { version } = await ownedVersion(tx, versionId, user, true);
      if (version.status === "ready" && version.buildHash !== null) {
        return { ok: true, buildHash: version.buildHash };
      }
      const files = await tx
        .select({ path: versionFiles.path, sha256: versionFiles.sha256, bytes: versionFiles.bytes })
        .from(versionFiles)
        .where(eq(versionFiles.versionId, versionId));
      const digests = new Map(files.map((file) => [file.path, file.sha256]));
      let outcome = await validateVersion({
        manifest: version.manifest,
        files,
        setup,
        async read(path) {
          const digest = digests.get(path);
          const bytes = digest === undefined ? null : await blobs.get(blobKey(digest));
          if (bytes === null) throw new Error("Uploaded file is missing from blob storage");
          return bytes;
        },
      });
      if (outcome.ok) outcome = await checkSharedHash(tx, version, outcome.buildHash);
      await tx
        .update(gameVersions)
        .set(
          outcome.ok
            ? {
                status: "ready",
                buildHash: outcome.buildHash,
                validationErrors: null,
                finalizedAt: new Date(),
              }
            : { status: "failed", buildHash: null, validationErrors: outcome.errors },
        )
        .where(eq(gameVersions.id, versionId));
      return outcome;
    });
    // Thrown after commit so the failed status and its errors are kept.
    if (!result.ok) throw validationFailed("Validation failed", result.errors);
    return FinalizeResponseSchema.parse({ buildHash: result.buildHash });
  });

  // Seat holders need the manifest to find the bundle and components file (T14).
  app.get("/api/versions/:versionId", { config: { auth: "any" } }, async (request) => {
    const params = request.params as Record<string, unknown>;
    const versionId = resourceId(params.versionId, "Version");
    const [version] = await db.select().from(gameVersions).where(eq(gameVersions.id, versionId));
    if (!version) throw notFound("Version");
    if (!(await canDownload(db, request, version))) throw forbidden();
    return versionResponse(version);
  });

  app.get(
    "/api/versions/:versionId/files/*",
    { config: { auth: "any" } },
    async (request, reply) => {
      const { versionId, path } = fileParams(request, () => notFound("File"));
      const [version] = await db.select().from(gameVersions).where(eq(gameVersions.id, versionId));
      if (!version) throw notFound("Version");
      if (!(await canDownload(db, request, version))) throw forbidden();
      const [file] = await db
        .select()
        .from(versionFiles)
        .where(and(eq(versionFiles.versionId, versionId), eq(versionFiles.path, path)));
      if (!file) throw notFound("File");
      const etag = `"${file.sha256}"`;
      reply
        .header("content-type", file.contentType)
        .header("etag", etag)
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'; sandbox")
        .header(
          "cache-control",
          version.status === "ready" ? "private, max-age=31536000, immutable" : "private, no-cache",
        );
      if (request.headers["if-none-match"] === etag) return reply.code(304).send();
      const bytes = await blobs.get(blobKey(file.sha256));
      if (bytes === null) throw new Error("Version file is missing from blob storage");
      return reply.send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    },
  );
};

/** Versions with identical files share a hash, so they must also agree on how to run it. */
async function checkSharedHash(
  db: Database,
  version: VersionRow,
  buildHash: string,
): Promise<FinalizeResult> {
  const others = await db
    .select({ manifest: gameVersions.manifest })
    .from(gameVersions)
    .where(and(eq(gameVersions.buildHash, buildHash), ne(gameVersions.id, version.id)));
  const entry = (manifest: VersionRow["manifest"]) =>
    manifest.mode === "enforced" ? manifest.entry : null;
  const mismatch = others.some(
    (other) =>
      other.manifest.mode !== version.manifest.mode ||
      entry(other.manifest) !== entry(version.manifest),
  );
  if (!mismatch) return { ok: true, buildHash };
  return {
    ok: false,
    errors: [
      {
        path: "entry",
        message: "Identical files were already published with a different mode or entry",
      },
    ],
  };
}
