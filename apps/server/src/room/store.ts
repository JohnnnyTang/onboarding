import type { AcceptedEvent, GameResult, Json, MatchState, MatchStatus } from "@bgp/schema";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { gameVersions, matchEvents, matches, matchSeats, matchSnapshots } from "../db/schema.js";

export interface StoredSeat {
  seat: string;
  userId: string | null;
  name: string;
  guest: boolean;
  claimed: boolean;
}

/** Server-only match record: it contains the seed. Never send it to a client. */
export interface StoredMatch {
  id: string;
  status: MatchStatus;
  createdBy: string;
  versionId: string;
  buildHash: string;
  seed: number;
  options: Json;
  lastSeq: number;
  seats: StoredSeat[];
}

export interface StoredSnapshot {
  seq: number;
  state: MatchState;
  stateHash: string;
}

export type AppendResult = "ok" | "inactive" | "conflict";

const bySeat = (a: { seat: string }, b: { seat: string }) => Number(a.seat) - Number(b.seat);

export async function loadMatch(db: Database, matchId: string): Promise<StoredMatch | null> {
  const [row] = await db
    .select({ match: matches, buildHash: gameVersions.buildHash })
    .from(matches)
    .innerJoin(gameVersions, eq(gameVersions.id, matches.versionId))
    .where(eq(matches.id, matchId));
  if (!row) return null;
  const seats = await db.select().from(matchSeats).where(eq(matchSeats.matchId, matchId));
  const { match } = row;
  // Matches are created from ready versions only, which always carry a build hash.
  if (row.buildHash === null) throw new Error("Match version has no build hash");
  return {
    id: match.id,
    status: match.status,
    createdBy: match.createdBy,
    versionId: match.versionId,
    buildHash: row.buildHash,
    seed: match.seed,
    options: match.options,
    lastSeq: match.lastSeq,
    seats: seats.sort(bySeat).map((seat) => ({
      seat: seat.seat,
      userId: seat.userId,
      name: seat.displayName ?? "",
      guest: seat.isGuest,
      claimed: seat.claimedAt !== null,
    })),
  };
}

export async function latestSnapshot(
  db: Database,
  matchId: string,
): Promise<StoredSnapshot | null> {
  const [row] = await db
    .select({
      seq: matchSnapshots.seq,
      state: matchSnapshots.state,
      stateHash: matchSnapshots.stateHash,
    })
    .from(matchSnapshots)
    .where(eq(matchSnapshots.matchId, matchId))
    .orderBy(desc(matchSnapshots.seq))
    .limit(1);
  return row ?? null;
}

export async function eventsAfter(
  db: Database,
  matchId: string,
  seq: number,
): Promise<AcceptedEvent[]> {
  return db
    .select({ seq: matchEvents.seq, seat: matchEvents.seat, intent: matchEvents.intent })
    .from(matchEvents)
    .where(and(eq(matchEvents.matchId, matchId), gt(matchEvents.seq, seq)))
    .orderBy(asc(matchEvents.seq));
}

/** Idempotent: a snapshot for a sequence number is written once. */
export async function insertSnapshot(
  db: Database,
  matchId: string,
  snapshot: StoredSnapshot,
): Promise<void> {
  await db
    .insert(matchSnapshots)
    .values({ matchId, ...snapshot })
    .onConflictDoNothing({ target: [matchSnapshots.matchId, matchSnapshots.seq] });
}

/**
 * Stores one accepted event in a single transaction with the `last_seq` bump, an optional
 * snapshot and, when the game has ended, the result. Nothing is stored unless the match is
 * still active and the event directly follows the stored log.
 */
export async function appendEvent(
  db: Database,
  matchId: string,
  event: AcceptedEvent,
  snapshot: StoredSnapshot | null,
  result: GameResult | null,
): Promise<AppendResult> {
  return db.transaction(async (tx) => {
    const [match] = await tx
      .select({ status: matches.status, lastSeq: matches.lastSeq })
      .from(matches)
      .where(eq(matches.id, matchId))
      .for("update");
    if (match?.status !== "active") return "inactive";
    if (match.lastSeq !== event.seq - 1) return "conflict";
    await tx.insert(matchEvents).values({ matchId, ...event });
    await tx
      .update(matches)
      .set({
        lastSeq: event.seq,
        ...(result ? { status: "finished" as const, result, finishedAt: new Date() } : {}),
      })
      .where(eq(matches.id, matchId));
    if (snapshot) await tx.insert(matchSnapshots).values({ matchId, ...snapshot });
    return "ok";
  });
}
