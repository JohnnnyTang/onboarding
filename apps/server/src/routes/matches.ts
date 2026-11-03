import { randomBytes } from "node:crypto";
import {
  ClaimInviteBodySchema,
  ClaimInviteResponseSchema,
  CreateMatchBodySchema,
  CreateMatchResponseSchema,
  EmptyBodySchema,
  FeedbackBodySchema,
  FeedbackResponseSchema,
  type Json,
  MatchListResponseSchema,
  type MatchSummary,
  MatchSummarySchema,
  optionsForManifestSchema,
  ReplayResponseSchema,
  type SeatInfo,
} from "@bgp/schema";
import { and, asc, desc, eq, exists, inArray, isNull, lt, or } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { AppDependencies } from "../app.js";
import type { Database } from "../db/connection.js";
import { createId } from "../db/id.js";
import {
  games,
  gameVersions,
  matchEvents,
  matches,
  matchFeedback,
  matchSeats,
} from "../db/schema.js";
import { currentUser, listQuery, page } from "../http/access.js";
import {
  ApiError,
  conflict,
  forbidden,
  issuesToErrors,
  notFound,
  parseRequest,
  resourceId,
  validationFailed,
} from "../http/errors.js";
import { sha256Hex } from "../versions/files.js";
import { defaultOptions } from "../versions/finalize.js";
import { isUniqueViolation } from "./games.js";

type MatchRow = typeof matches.$inferSelect;
type SeatRow = typeof matchSeats.$inferSelect;

const INVITE_TOKEN = /^[A-Za-z0-9_-]{22}$/;
const bySeat = (a: { seat: string }, b: { seat: string }) => Number(a.seat) - Number(b.seat);

function seatInfo(seat: SeatRow): SeatInfo {
  // Presence belongs to the room server (T11); an unclaimed seat has an empty name.
  return { seat: seat.seat, name: seat.displayName ?? "", connected: false, guest: seat.isGuest };
}

/** Summaries never include the seed, options, RNG or state. */
async function summaries(db: Database, rows: MatchRow[]): Promise<MatchSummary[]> {
  if (rows.length === 0) return [];
  const versions = await db
    .select({ id: gameVersions.id, buildHash: gameVersions.buildHash })
    .from(gameVersions)
    .where(inArray(gameVersions.id, [...new Set(rows.map((row) => row.versionId))]));
  const seats = await db
    .select()
    .from(matchSeats)
    .where(
      inArray(
        matchSeats.matchId,
        rows.map((row) => row.id),
      ),
    );
  return rows.map((match) =>
    MatchSummarySchema.parse({
      id: match.id,
      status: match.status,
      versionId: match.versionId,
      buildHash: versions.find((version) => version.id === match.versionId)?.buildHash,
      seats: seats
        .filter((seat) => seat.matchId === match.id)
        .sort(bySeat)
        .map(seatInfo),
    }),
  );
}

async function summary(db: Database, match: MatchRow): Promise<MatchSummary> {
  const [result] = await summaries(db, [match]);
  if (!result) throw new Error("Missing match summary");
  return result;
}

interface MatchAccess {
  match: MatchRow;
  owner: boolean;
  /** The caller's claimed seat in this match, if any. */
  seat: string | null;
}

/** Owner or seat holder; guest scope was checked by the auth hook, membership is checked here. */
async function matchAccess(
  db: Database,
  request: FastifyRequest,
  lock = false,
): Promise<MatchAccess> {
  const matchId = resourceId((request.params as { matchId: unknown }).matchId, "Match");
  const query = db.select().from(matches).where(eq(matches.id, matchId));
  const [match] = lock ? await query.for("update") : await query;
  if (!match) throw notFound("Match");
  const identity = request.identity;
  if (!identity) throw forbidden();
  const condition =
    identity.kind === "user"
      ? eq(matchSeats.userId, identity.user.id)
      : and(eq(matchSeats.seat, identity.seat), eq(matchSeats.isGuest, true));
  const [seat] = await db
    .select({ seat: matchSeats.seat })
    .from(matchSeats)
    .where(and(eq(matchSeats.matchId, match.id), condition));
  const owner = identity.kind === "user" && match.createdBy === identity.user.id;
  if (!owner && !seat) throw forbidden();
  return { match, owner, seat: seat?.seat ?? null };
}

async function ownedMatch(db: Database, request: FastifyRequest): Promise<MatchRow> {
  const access = await matchAccess(db, request, true);
  if (!access.owner) throw forbidden();
  return access.match;
}

function isObject(value: Json): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const matchRoutes: FastifyPluginAsync<AppDependencies> = async (app, deps) => {
  const { db, auth } = deps;

  app.post("/api/matches", async (request, reply) => {
    const user = currentUser(request);
    const body = parseRequest(CreateMatchBodySchema, request.body);
    const versionId = resourceId(body.versionId, "Version");
    const [row] = await db
      .select({ version: gameVersions, ownerId: games.ownerId })
      .from(gameVersions)
      .innerJoin(games, eq(games.id, gameVersions.gameId))
      .where(eq(gameVersions.id, versionId));
    if (!row) throw notFound("Version");
    if (row.ownerId !== user.id) throw forbidden();
    const { version } = row;
    if (version.status !== "ready") throw conflict("Only ready versions can host matches");
    const { min, max } = version.manifest.players;
    const errors = [];
    if (body.seatCount < min || body.seatCount > max) {
      errors.push({ path: "seatCount", message: `This game seats ${min} to ${max} players` });
    }
    const options = isObject(body.options)
      ? { ...defaultOptions(version.manifest), ...body.options }
      : body.options;
    const checked = optionsForManifestSchema(version.manifest).safeParse(options);
    if (!checked.success) errors.push(...issuesToErrors(checked.error.issues, "options"));
    if (errors.length > 0 || !checked.success) throw validationFailed("Invalid match", errors);

    const matchId = createId();
    // The seed reveals every hidden card with the intents, so it stays server-side until the end.
    const seed = randomBytes(4).readUInt32BE(0);
    const invites = Array.from({ length: body.seatCount }, (_, index) => ({
      seat: String(index),
      token: randomBytes(16).toString("base64url"),
    }));
    const match = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(matches)
        .values({
          id: matchId,
          versionId,
          createdBy: user.id,
          status: "lobby",
          seatCount: body.seatCount,
          seed,
          options: checked.data,
        })
        .returning();
      await tx.insert(matchSeats).values(
        invites.map((invite) => ({
          matchId,
          seat: invite.seat,
          isGuest: false,
          inviteTokenHash: sha256Hex(invite.token),
        })),
      );
      if (!created) throw new Error("Insert returned no match");
      return created;
    });
    return reply.code(201).send(
      CreateMatchResponseSchema.parse({
        match: await summary(db, match),
        invites: invites.map((invite) => ({
          seat: invite.seat,
          url: new URL(`/join/${invite.token}`, deps.publicWebOrigin).href,
        })),
      }),
    );
  });

  app.get("/api/matches", async (request) => {
    const user = currentUser(request);
    const { limit, cursor } = listQuery(request.query);
    const seated = db
      .select({ matchId: matchSeats.matchId })
      .from(matchSeats)
      .where(and(eq(matchSeats.matchId, matches.id), eq(matchSeats.userId, user.id)));
    const rows = await db
      .select()
      .from(matches)
      .where(
        and(
          or(eq(matches.createdBy, user.id), exists(seated)),
          cursor ? lt(matches.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(matches.id))
      .limit(limit + 1);
    const result = page(rows, limit);
    return MatchListResponseSchema.parse({
      items: await summaries(db, result.items),
      cursor: result.cursor,
    });
  });

  app.get("/api/matches/:matchId", { config: { auth: "match" } }, async (request) => {
    const { match } = await matchAccess(db, request);
    return summary(db, match);
  });

  app.post("/api/matches/:matchId/start", async (request) => {
    parseRequest(EmptyBodySchema, request.body ?? {});
    const match = await db.transaction(async (tx) => {
      const current = await ownedMatch(tx, request);
      if (current.status !== "lobby") throw conflict("Only a match in the lobby can start");
      const [version] = await tx
        .select({ manifest: gameVersions.manifest })
        .from(gameVersions)
        .where(eq(gameVersions.id, current.versionId));
      if (!version) throw new Error("Match without a version");
      const seats = await tx.select().from(matchSeats).where(eq(matchSeats.matchId, current.id));
      const claimed = seats.filter((seat) => seat.claimedAt !== null).sort(bySeat);
      const min = version.manifest.players.min;
      if (claimed.length < min) throw conflict(`At least ${min} seats must be filled to start`);
      // Rules seats are numbered from 0 without gaps, so players are a prefix of the seats.
      if (!claimed.every((seat, index) => seat.seat === String(index))) {
        throw conflict("Filled seats must be the first seats, without gaps");
      }
      await tx
        .delete(matchSeats)
        .where(and(eq(matchSeats.matchId, current.id), isNull(matchSeats.claimedAt)));
      const [started] = await tx
        .update(matches)
        .set({ status: "active", startedAt: new Date(), seatCount: claimed.length })
        .where(eq(matches.id, current.id))
        .returning();
      if (!started) throw new Error("Update returned no match");
      return started;
    });
    return summary(db, match);
  });

  app.post("/api/matches/:matchId/abandon", async (request) => {
    parseRequest(EmptyBodySchema, request.body ?? {});
    const match = await db.transaction(async (tx) => {
      const current = await ownedMatch(tx, request);
      if (current.status !== "lobby" && current.status !== "active") {
        throw conflict("The match has already ended");
      }
      const [abandoned] = await tx
        .update(matches)
        .set({ status: "abandoned", finishedAt: new Date() })
        .where(eq(matches.id, current.id))
        .returning();
      if (!abandoned) throw new Error("Update returned no match");
      return abandoned;
    });
    return summary(db, match);
  });

  app.post("/api/invites/:token/claim", { config: { auth: "optional" } }, async (request) => {
    const token = (request.params as { token: unknown }).token;
    if (typeof token !== "string" || !INVITE_TOKEN.test(token)) throw notFound("Invite");
    const body = parseRequest(ClaimInviteBodySchema, request.body);
    const identity = request.identity;
    const user = identity?.kind === "user" ? identity.user : null;
    try {
      const seat = await db.transaction(async (tx) => {
        const [row] = await tx
          .select({ seat: matchSeats, status: matches.status })
          .from(matchSeats)
          .innerJoin(matches, eq(matches.id, matchSeats.matchId))
          .where(eq(matchSeats.inviteTokenHash, sha256Hex(token)))
          .for("update");
        if (!row) throw notFound("Invite");
        if (row.status !== "lobby") throw conflict("Seats can only be claimed in the lobby");
        if (row.seat.claimedAt !== null) throw conflict("This seat is already taken");
        await tx
          .update(matchSeats)
          .set({
            userId: user?.id ?? null,
            displayName: body.displayName,
            isGuest: user === null,
            claimedAt: new Date(),
          })
          .where(and(eq(matchSeats.matchId, row.seat.matchId), eq(matchSeats.seat, row.seat.seat)));
        return row.seat;
      });
      const guestToken =
        user === null
          ? await auth.issueGuestToken({ matchId: seat.matchId, seat: seat.seat })
          : undefined;
      return ClaimInviteResponseSchema.parse({
        matchId: seat.matchId,
        seat: seat.seat,
        ...(guestToken ? { guestToken } : {}),
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("You already hold a seat in this match");
      throw error;
    }
  });

  app.get("/api/matches/:matchId/replay", { config: { auth: "match" } }, async (request) => {
    const { match } = await matchAccess(db, request);
    if (match.status !== "finished") {
      throw conflict("Replays are available once the match has finished");
    }
    const [version] = await db
      .select({ buildHash: gameVersions.buildHash })
      .from(gameVersions)
      .where(eq(gameVersions.id, match.versionId));
    const seats = await db
      .select({ seat: matchSeats.seat })
      .from(matchSeats)
      .where(eq(matchSeats.matchId, match.id));
    const events = await db
      .select({ seq: matchEvents.seq, seat: matchEvents.seat, intent: matchEvents.intent })
      .from(matchEvents)
      .where(eq(matchEvents.matchId, match.id))
      .orderBy(asc(matchEvents.seq));
    return ReplayResponseSchema.parse({
      buildHash: version?.buildHash,
      seats: seats.sort(bySeat).map((seat) => seat.seat),
      seed: match.seed,
      options: match.options,
      events,
    });
  });

  app.post(
    "/api/matches/:matchId/feedback",
    { config: { auth: "match" } },
    async (request, reply) => {
      const access = await matchAccess(db, request);
      if (access.seat === null) {
        throw new ApiError(403, "FORBIDDEN", "Feedback needs a seat in this match");
      }
      const body = parseRequest(FeedbackBodySchema, request.body);
      if (body.seq > access.match.lastSeq) {
        throw validationFailed("Invalid feedback", [
          { path: "seq", message: "The match has not reached this moment" },
        ]);
      }
      const [created] = await db
        .insert(matchFeedback)
        .values({ id: createId(), matchId: access.match.id, seat: access.seat, ...body })
        .returning();
      if (!created) throw new Error("Insert returned no feedback");
      return reply.code(201).send(
        FeedbackResponseSchema.parse({
          id: created.id,
          seq: created.seq,
          body: created.body,
          createdAt: created.createdAt.toISOString(),
        }),
      );
    },
  );
};
