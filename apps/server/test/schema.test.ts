import { ManifestSchema, MatchStateSchema, MoveIntentSchema } from "@bgp/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectDatabase, type DatabaseConnection } from "../src/db/connection.js";
import { migrateDatabase } from "../src/db/migrate.js";
import * as schema from "../src/db/schema.js";
import { testDatabaseUrl } from "./database.js";

const id = (value: number) => `019a0000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const manifest = ManifestSchema.parse({
  schemaVersion: 1,
  id: "db-fixture",
  name: "Database fixture",
  version: "1.0.0",
  sdk: 1,
  mode: "sandbox",
  players: { min: 1, max: 8 },
  components: "components.json",
});
const initialState = MatchStateSchema.parse({
  v: 1,
  game: { hiddenCard: "server-only" },
  ctx: {
    seats: ["0"],
    currentSeat: "0",
    activeSeats: ["0"],
    phase: "play",
    turn: 1,
    moveNumber: 0,
    options: {},
  },
  rng: [1, 2, 3, 4],
  result: null,
});
const user = {
  id: id(1),
  oidcIssuer: "https://issuer.example.test",
  oidcSubject: "designer",
  displayName: "Designer",
};
const game = {
  id: id(2),
  ownerId: id(1),
  slug: "db-fixture",
  name: "Fixture",
  visibility: "private" as const,
};
const version = {
  id: id(3),
  gameId: id(2),
  version: "1.0.0",
  mode: "sandbox" as const,
  status: "draft" as const,
  manifest,
};
const match = {
  id: id(4),
  versionId: id(3),
  createdBy: id(1),
  status: "lobby" as const,
  seatCount: 1,
  seed: 0xffffffff,
  options: {},
};
const event = {
  matchId: id(4),
  seq: 1,
  seat: "0",
  intent: MoveIntentSchema.parse({ move: "pass" }),
};
const seat = { matchId: id(4), seat: "0", isGuest: true, inviteTokenHash: "a".repeat(64) };
type Transaction = Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0];
let connection: DatabaseConnection;

// No TRUNCATE or DELETE: every fixture is rolled back, including on assertion failures.
async function fixture(run: (tx: Transaction) => Promise<void>): Promise<void> {
  const rollback = new Error("rollback successful test fixture");
  try {
    await connection.db.transaction(async (tx) => {
      await tx.insert(schema.users).values(user);
      await tx.insert(schema.games).values(game);
      await tx.insert(schema.gameVersions).values(version);
      await tx.insert(schema.matches).values(match);
      await run(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

beforeAll(() => {
  connection = connectDatabase(testDatabaseUrl());
});
afterAll(async () => {
  await connection?.close();
});

describe("PostgreSQL migrations and constraints", () => {
  it("migrates idempotently and creates every documented table", async () => {
    await migrateDatabase(testDatabaseUrl());
    const rows = await connection.client<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name
    `;
    expect(rows.map((row) => row.table_name)).toEqual([
      "game_versions",
      "games",
      "match_events",
      "match_feedback",
      "match_seats",
      "match_snapshots",
      "matches",
      "users",
      "version_files",
    ]);
  });

  it("round-trips draft metadata, nullable claims, uint32 seeds and server snapshots", async () => {
    await fixture(async (tx) => {
      await tx.insert(schema.matchSeats).values(seat);
      await tx.insert(schema.versionFiles).values({
        versionId: id(3),
        path: "components.json",
        sha256: "b".repeat(64),
        bytes: 10,
        contentType: "application/json",
      });
      await tx
        .insert(schema.matchSnapshots)
        .values({ matchId: id(4), seq: 0, state: initialState, stateHash: "c".repeat(64) });
      await tx
        .insert(schema.matchFeedback)
        .values({ id: id(5), matchId: id(4), seq: 0, seat: "0", body: "Playtest feedback" });
      const [storedVersion] = await tx.select().from(schema.gameVersions);
      expect(storedVersion?.manifest).toEqual(manifest);
      expect(storedVersion?.buildHash).toBeNull();
      expect(storedVersion?.finalizedAt).toBeNull();
      const [storedMatch] = await tx.select().from(schema.matches);
      expect(storedMatch).toMatchObject({
        seed: 0xffffffff,
        lastSeq: 0,
        result: null,
        startedAt: null,
        finishedAt: null,
      });
      expect(storedMatch?.createdAt).toBeInstanceOf(Date);
      const [storedSeat] = await tx.select().from(schema.matchSeats);
      expect(storedSeat).toMatchObject({ userId: null, displayName: null, claimedAt: null });
      const [snapshot] = await tx.select().from(schema.matchSnapshots);
      expect(MatchStateSchema.parse(snapshot?.state)).toEqual(initialState);
    });
  });

  it("uniquely identifies users by issuer and subject together", async () => {
    await fixture(async (tx) => {
      await tx
        .insert(schema.users)
        .values({ ...user, id: id(5), oidcIssuer: "https://second.example.test" });
      await expect(tx.insert(schema.users).values({ ...user, id: id(6) })).rejects.toMatchObject({
        cause: { code: "23505" },
      });
    });
  });

  it("rejects missing foreign keys", async () => {
    await fixture(async (tx) => {
      await expect(
        tx
          .insert(schema.games)
          .values({ ...game, id: id(5), slug: "missing-owner", ownerId: id(99) }),
      ).rejects.toMatchObject({ cause: { code: "23503" } });
    });
  });

  it("allows multiple drafts without hashes but rejects duplicate game versions", async () => {
    await fixture(async (tx) => {
      await tx.insert(schema.gameVersions).values({ ...version, id: id(5), version: "1.0.1" });
      await expect(
        tx.insert(schema.gameVersions).values({ ...version, id: id(6) }),
      ).rejects.toMatchObject({ cause: { code: "23505" } });
    });
  });

  it("deduplicates non-null build hashes", async () => {
    await fixture(async (tx) => {
      await tx
        .update(schema.gameVersions)
        .set({ status: "ready", buildHash: "a".repeat(64), finalizedAt: new Date() })
        .where(eq(schema.gameVersions.id, id(3)));
      await expect(
        tx
          .insert(schema.gameVersions)
          .values({ ...version, id: id(5), version: "1.0.1", buildHash: "a".repeat(64) }),
      ).rejects.toMatchObject({ cause: { code: "23505" } });
    });
  });

  it("makes invite hashes unique across seats", async () => {
    await fixture(async (tx) => {
      await tx.insert(schema.matchSeats).values(seat);
      await expect(
        tx.insert(schema.matchSeats).values({ ...seat, seat: "1" }),
      ).rejects.toMatchObject({ cause: { code: "23505" } });
    });
  });

  it.each([-1, 4294967296])("rejects seed %s outside uint32", async (seed) => {
    await fixture(async (tx) => {
      await expect(
        tx.insert(schema.matches).values({ ...match, id: id(5), seed }),
      ).rejects.toMatchObject({ cause: { code: "23514" } });
    });
  });

  it.each([0, 9])("rejects seat count %s outside the contract", async (seatCount) => {
    await fixture(async (tx) => {
      await expect(
        tx.insert(schema.matches).values({ ...match, id: id(5), seatCount }),
      ).rejects.toMatchObject({ cause: { code: "23514" } });
    });
  });

  it("stores an event and sequence advancement in one transaction", async () => {
    await fixture(async (tx) => {
      await tx.insert(schema.matchEvents).values(event);
      await tx
        .update(schema.matches)
        .set({ lastSeq: sql`${schema.matches.lastSeq} + 1` })
        .where(eq(schema.matches.id, id(4)));
      const [stored] = await tx.select().from(schema.matches);
      expect(stored?.lastSeq).toBe(1);
      const [storedEvent] = await tx.select().from(schema.matchEvents);
      expect(storedEvent?.intent).toEqual(event.intent);
      await expect(tx.insert(schema.matchEvents).values(event)).rejects.toMatchObject({
        cause: { code: "23505" },
      });
    });
    expect(
      await connection.db
        .select()
        .from(schema.matchEvents)
        .where(eq(schema.matchEvents.matchId, id(4))),
    ).toEqual([]);
    expect(
      await connection.db
        .select()
        .from(schema.matches)
        .where(eq(schema.matches.id, id(4))),
    ).toEqual([]);
  });

  it.each(["update", "delete"] as const)(
    "rejects %s of accepted event history",
    async (operation) => {
      await fixture(async (tx) => {
        await tx.insert(schema.matchEvents).values(event);
        const mutation =
          operation === "update"
            ? tx
                .update(schema.matchEvents)
                .set({ seat: "1" })
                .where(eq(schema.matchEvents.matchId, id(4)))
            : tx.delete(schema.matchEvents).where(eq(schema.matchEvents.matchId, id(4)));
        await expect(mutation).rejects.toMatchObject({ cause: { code: "55000" } });
      });
    },
  );

  it("requires events to start at sequence 1", async () => {
    await fixture(async (tx) => {
      await expect(
        tx.insert(schema.matchEvents).values({ ...event, seq: 0 }),
      ).rejects.toMatchObject({ cause: { code: "23514" } });
    });
  });
});
