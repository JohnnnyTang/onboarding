import {
  ClaimInviteResponseSchema,
  CreateMatchResponseSchema,
  HttpErrorSchema,
  MatchListResponseSchema,
  MatchSummarySchema,
  ReplayResponseSchema,
  VersionResponseSchema,
} from "@bgp/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchEvents, matches, matchSeats } from "../src/db/schema.js";
import {
  type Api,
  createDraft,
  createGame,
  type Harness,
  publish,
  sandboxPackage,
  sha256,
  startHarness,
  WEB_ORIGIN,
  withApi,
} from "./api-fixture.js";

let harness: Harness;
beforeAll(async () => {
  harness = await startHarness();
});
afterAll(async () => {
  await harness?.close();
});

const code = (response: { json(): unknown }) => HttpErrorSchema.parse(response.json()).error.code;

/** Owner token, a ready version and a 3-seat lobby with its invite tokens. */
async function lobby(api: Api, seatCount = 3, options: unknown = {}) {
  const owner = await api.designer();
  const { versionId, response } = await publish(api, owner, sandboxPackage());
  if (response.statusCode !== 200) throw new Error(response.body);
  const created = await api.call("POST", "/api/matches", {
    token: owner,
    body: { versionId, seatCount, options },
  });
  if (created.statusCode !== 201) throw new Error(created.body);
  const body = CreateMatchResponseSchema.parse(created.json());
  const tokens = body.invites.map((invite) => invite.url.slice(`${WEB_ORIGIN}/join/`.length));
  return { owner, versionId, matchId: body.match.id, body, tokens, raw: created.body };
}

function claim(api: Api, token: string, displayName: string, auth?: string) {
  return api.call("POST", `/api/invites/${token}/claim`, {
    body: { displayName },
    ...(auth ? { token: auth } : {}),
  });
}

async function seed(api: Api, matchId: string) {
  const [row] = await api.db
    .select({ seed: matches.seed })
    .from(matches)
    .where(eq(matches.id, matchId));
  if (!row) throw new Error("missing match");
  return row.seed;
}

/** The seed must never reach a client before the match finishes. */
function expectNoSeed(raw: string, value: number) {
  expect(raw).not.toMatch(/"seed"/);
  expect(raw).not.toContain(`:${value}`);
}

describe("match creation", () => {
  it("creates a lobby with one hashed invite per seat and keeps the seed secret", async () => {
    await withApi(harness, async (api) => {
      const { matchId, body, tokens, raw, versionId } = await lobby(api);
      expect(body.match).toMatchObject({ status: "lobby", versionId });
      expect(body.match.seats).toEqual(
        ["0", "1", "2"].map((seat) => ({ seat, name: "", connected: false, guest: false })),
      );
      expect(body.invites.map((invite) => invite.seat)).toEqual(["0", "1", "2"]);
      for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expectNoSeed(raw, await seed(api, matchId));

      const stored = await api.db.select().from(matchSeats).where(eq(matchSeats.matchId, matchId));
      expect(stored.map((row) => row.inviteTokenHash).sort()).toEqual(
        tokens.map((t) => sha256(t)).sort(),
      );
      expect(JSON.stringify(stored)).not.toContain(tokens[0]);
      const [match] = await api.db.select().from(matches).where(eq(matches.id, matchId));
      expect(match?.options).toEqual({ variant: false });
    });
  });

  it("validates seat counts, options, version state and ownership", async () => {
    await withApi(harness, async (api) => {
      const owner = await api.designer();
      const { versionId, gameId } = await publish(api, owner, sandboxPackage());
      const create = (body: object, token = owner) =>
        api.call("POST", "/api/matches", { token, body });

      const seats = await create({ versionId, seatCount: 5, options: {} });
      expect(HttpErrorSchema.parse(seats.json()).error).toMatchObject({
        code: "VALIDATION_FAILED",
        errors: [{ path: "seatCount", message: "This game seats 1 to 4 players" }],
      });
      for (const options of [{ unknown: true }, { variant: 3 }, [1]]) {
        const response = await create({ versionId, seatCount: 2, options });
        expect([response.statusCode, code(response)]).toEqual([400, "VALIDATION_FAILED"]);
      }
      const draft = await createDraft(api, owner, gameId, {
        ...sandboxPackage().manifest,
        version: "0.2.0",
      });
      const notReady = await create({ versionId: draft, seatCount: 2, options: {} });
      expect([notReady.statusCode, code(notReady)]).toEqual([409, "CONFLICT"]);
      const foreign = await create(
        { versionId, seatCount: 2, options: {} },
        await api.designer("designer-2"),
      );
      expect([foreign.statusCode, code(foreign)]).toEqual([403, "FORBIDDEN"]);
      const unknown = await create({ versionId: "not-a-uuid", seatCount: 2, options: {} });
      expect([unknown.statusCode, code(unknown)]).toEqual([404, "NOT_FOUND"]);
      const created = await create({ versionId, seatCount: 2, options: { variant: true } });
      expect(created.statusCode).toBe(201);
    });
  });
});

describe("invites and match access", () => {
  it("lets guests claim seats with match-scoped tokens and users bind seats to accounts", async () => {
    await withApi(harness, async (api) => {
      const { owner, matchId, tokens } = await lobby(api);
      const [ownerSeat, guestSeat, userSeat] = tokens as [string, string, string];
      const ownerClaim = await claim(api, ownerSeat, "Owner", owner);
      expect(ClaimInviteResponseSchema.parse(ownerClaim.json())).toEqual({ matchId, seat: "0" });

      const guest = ClaimInviteResponseSchema.parse((await claim(api, guestSeat, "Guest")).json());
      expect(guest).toMatchObject({ matchId, seat: "1" });
      expect(guest.guestToken).toBeDefined();

      const designer2 = await api.designer("designer-2");
      expect((await claim(api, userSeat, "Two", designer2)).statusCode).toBe(200);

      const summary = await api.call("GET", `/api/matches/${matchId}`, { token: guest.guestToken });
      const parsed = MatchSummarySchema.parse(summary.json());
      expect(parsed.seats).toEqual([
        { seat: "0", name: "Owner", connected: false, guest: false },
        { seat: "1", name: "Guest", connected: false, guest: true },
        { seat: "2", name: "Two", connected: false, guest: false },
      ]);
      expectNoSeed(summary.body, await seed(api, matchId));

      const taken = await claim(api, guestSeat, "Again");
      expect([taken.statusCode, code(taken)]).toEqual([409, "CONFLICT"]);
      const unknown = await claim(api, "A".repeat(22), "Nobody");
      expect([unknown.statusCode, code(unknown)]).toEqual([404, "NOT_FOUND"]);
      const malformed = await claim(api, "short", "Nobody");
      expect(malformed.statusCode).toBe(404);
      const badName = await claim(api, "A".repeat(22), "");
      expect(badName.statusCode).toBe(400);

      // The seated designer sees the match in their list; guests cannot list matches.
      const listed = MatchListResponseSchema.parse(
        (await api.call("GET", "/api/matches", { token: designer2 })).json(),
      );
      expect(listed.items.map((item) => item.id)).toEqual([matchId]);
      expectNoSeed(JSON.stringify(listed), await seed(api, matchId));
      const guestList = await api.call("GET", "/api/matches", { token: guest.guestToken });
      expect([guestList.statusCode, code(guestList)]).toEqual([403, "FORBIDDEN"]);
    });
  });

  it("refuses a second seat for the same account", async () => {
    await withApi(harness, async (api) => {
      const { owner, tokens } = await lobby(api);
      expect((await claim(api, tokens[0] ?? "", "Owner", owner)).statusCode).toBe(200);
      const second = await claim(api, tokens[1] ?? "", "Owner again", owner);
      expect([second.statusCode, code(second)]).toEqual([409, "CONFLICT"]);
      // The refused claim left the seat free for someone else.
      expect((await claim(api, tokens[1] ?? "", "Guest")).statusCode).toBe(200);
    });
  });

  it("limits match reads to the owner and seat holders", async () => {
    await withApi(harness, async (api) => {
      const first = await lobby(api);
      const guest = ClaimInviteResponseSchema.parse(
        (await claim(api, first.tokens[0] ?? "", "Guest")).json(),
      );
      const second = await api.call("POST", "/api/matches", {
        token: first.owner,
        body: { versionId: first.versionId, seatCount: 1, options: {} },
      });
      const otherMatch = CreateMatchResponseSchema.parse(second.json()).match.id;

      const outsider = await api.designer("designer-2");
      const read = (matchId: string, token?: string) =>
        api.call("GET", `/api/matches/${matchId}`, { token });
      expect((await read(first.matchId, first.owner)).statusCode).toBe(200);
      expect((await read(first.matchId, guest.guestToken)).statusCode).toBe(200);
      const wrongMatch = await read(otherMatch, guest.guestToken);
      expect([wrongMatch.statusCode, code(wrongMatch)]).toEqual([403, "FORBIDDEN"]);
      const notSeated = await read(first.matchId, outsider);
      expect([notSeated.statusCode, code(notSeated)]).toEqual([403, "FORBIDDEN"]);
      expect((await read(first.matchId)).statusCode).toBe(401);
      const missing = await read("00000000-0000-7000-8000-000000000000", first.owner);
      expect([missing.statusCode, code(missing)]).toEqual([404, "NOT_FOUND"]);
    });
  });

  it("lets seat holders, including guests, download the version's files", async () => {
    await withApi(harness, async (api) => {
      const { tokens, versionId } = await lobby(api);
      const guest = ClaimInviteResponseSchema.parse(
        (await claim(api, tokens[0] ?? "", "Guest")).json(),
      );
      const file = `/api/versions/${versionId}/files/components.json`;
      expect((await api.call("GET", file, { token: guest.guestToken })).statusCode).toBe(200);
      const designer2 = await api.designer("designer-2");
      expect((await api.call("GET", file, { token: designer2 })).statusCode).toBe(403);
      expect((await claim(api, tokens[1] ?? "", "Two", designer2)).statusCode).toBe(200);
      expect((await api.call("GET", file, { token: designer2 })).statusCode).toBe(200);

      // A guest of another version's match gets nothing from this one.
      const owner = await api.designer();
      const other = await publish(api, owner, sandboxPackage("other-game"));
      const otherMatch = await api.call("POST", "/api/matches", {
        token: owner,
        body: { versionId: other.versionId, seatCount: 1, options: {} },
      });
      const otherToken = CreateMatchResponseSchema.parse(otherMatch.json()).invites[0]?.url.split(
        "/join/",
      )[1];
      const otherGuest = ClaimInviteResponseSchema.parse(
        (await claim(api, otherToken ?? "", "Else")).json(),
      );
      expect((await api.call("GET", file, { token: otherGuest.guestToken })).statusCode).toBe(403);
    });
  });

  it("lets seat holders read the version's manifest", async () => {
    await withApi(harness, async (api) => {
      const { owner, tokens, versionId } = await lobby(api);
      const guest = ClaimInviteResponseSchema.parse(
        (await claim(api, tokens[0] ?? "", "Guest")).json(),
      );
      const path = `/api/versions/${versionId}`;
      const read = (token?: string) => api.call("GET", path, { token });
      const byGuest = await read(guest.guestToken);
      expect(byGuest.statusCode).toBe(200);
      const version = VersionResponseSchema.parse(byGuest.json());
      expect(version).toMatchObject({ id: versionId, status: "ready" });
      expect(version.manifest.components).toBe("components.json");
      expect((await read(owner)).statusCode).toBe(200);
      const outsider = await read(await api.designer("designer-2"));
      expect([outsider.statusCode, code(outsider)]).toEqual([403, "FORBIDDEN"]);
      expect((await read()).statusCode).toBe(401);
      const missing = await api.call("GET", "/api/versions/00000000-0000-7000-8000-000000000000", {
        token: owner,
      });
      expect([missing.statusCode, code(missing)]).toEqual([404, "NOT_FOUND"]);
    });
  });
});

describe("match lifecycle", () => {
  it("starts with a filled prefix of seats, drops the empty ones and closes the lobby", async () => {
    await withApi(harness, async (api) => {
      const { owner, matchId, tokens } = await lobby(api, 4);
      const start = () => api.call("POST", `/api/matches/${matchId}/start`, { token: owner });
      await claim(api, tokens[1] ?? "", "Second");
      const gap = await start();
      expect([gap.statusCode, code(gap)]).toEqual([409, "CONFLICT"]);
      const guest = ClaimInviteResponseSchema.parse(
        (await claim(api, tokens[0] ?? "", "First")).json(),
      );

      const byGuest = await api.call("POST", `/api/matches/${matchId}/start`, {
        token: guest.guestToken,
      });
      expect([byGuest.statusCode, code(byGuest)]).toEqual([403, "FORBIDDEN"]);
      const designer2 = await api.designer("designer-2");
      const byOther = await api.call("POST", `/api/matches/${matchId}/start`, { token: designer2 });
      expect([byOther.statusCode, code(byOther)]).toEqual([403, "FORBIDDEN"]);

      const started = await start();
      expect(started.statusCode).toBe(200);
      const summary = MatchSummarySchema.parse(started.json());
      expect(summary.status).toBe("active");
      expect(summary.seats.map((seat) => seat.seat)).toEqual(["0", "1"]);
      expectNoSeed(started.body, await seed(api, matchId));
      const late = await claim(api, tokens[2] ?? "", "Late");
      expect(late.statusCode).toBe(404);
      expect((await start()).statusCode).toBe(409);
    });
  });

  it("requires the minimum number of filled seats", async () => {
    await withApi(harness, async (api) => {
      const owner = await api.designer();
      const pkg = sandboxPackage();
      const { versionId } = await publish(api, owner, {
        ...pkg,
        manifest: { ...pkg.manifest, players: { min: 2, max: 4 } },
      });
      const created = CreateMatchResponseSchema.parse(
        (
          await api.call("POST", "/api/matches", {
            token: owner,
            body: { versionId, seatCount: 2, options: {} },
          })
        ).json(),
      );
      await claim(api, created.invites[0]?.url.split("/join/")[1] ?? "", "Only");
      const response = await api.call("POST", `/api/matches/${created.match.id}/start`, {
        token: owner,
      });
      expect([response.statusCode, code(response)]).toEqual([409, "CONFLICT"]);
      expect(HttpErrorSchema.parse(response.json()).error.message).toBe(
        "At least 2 seats must be filled to start",
      );
    });
  });

  it("abandons lobby or active matches once", async () => {
    await withApi(harness, async (api) => {
      const { owner, matchId, tokens } = await lobby(api);
      const guest = ClaimInviteResponseSchema.parse(
        (await claim(api, tokens[0] ?? "", "Guest")).json(),
      );
      const abandon = (token?: string) =>
        api.call("POST", `/api/matches/${matchId}/abandon`, { token, body: {} });
      expect((await abandon(guest.guestToken)).statusCode).toBe(403);
      const done = await abandon(owner);
      expect(MatchSummarySchema.parse(done.json()).status).toBe("abandoned");
      expect((await abandon(owner)).statusCode).toBe(409);
      const replay = await api.call("GET", `/api/matches/${matchId}/replay`, { token: owner });
      expect([replay.statusCode, code(replay)]).toEqual([409, "CONFLICT"]);
    });
  });

  it("reveals the seed and events through the replay only after the match finishes", async () => {
    await withApi(harness, async (api) => {
      const { owner, matchId, tokens, body } = await lobby(api, 2);
      await claim(api, tokens[0] ?? "", "First", owner);
      const guest = ClaimInviteResponseSchema.parse(
        (await claim(api, tokens[1] ?? "", "Second")).json(),
      );
      await api.call("POST", `/api/matches/${matchId}/start`, { token: owner });
      const intent = { move: "op", args: { op: "flip", item: "x" } };
      await api.db.insert(matchEvents).values([
        { matchId, seq: 1, seat: "0", intent },
        { matchId, seq: 2, seat: "1", intent },
      ]);
      const early = await api.call("GET", `/api/matches/${matchId}/replay`, {
        token: guest.guestToken,
      });
      expect([early.statusCode, code(early)]).toEqual([409, "CONFLICT"]);
      expect(early.body).not.toContain(String(await seed(api, matchId)));

      await api.db
        .update(matches)
        .set({ status: "finished", lastSeq: 2, finishedAt: new Date() })
        .where(eq(matches.id, matchId));
      const replay = await api.call("GET", `/api/matches/${matchId}/replay`, {
        token: guest.guestToken,
      });
      expect(ReplayResponseSchema.parse(replay.json())).toEqual({
        buildHash: body.match.buildHash,
        seats: ["0", "1"],
        seed: await seed(api, matchId),
        options: { variant: false },
        events: [
          { seq: 1, seat: "0", intent },
          { seq: 2, seat: "1", intent },
        ],
      });
      const outsider = await api.call("GET", `/api/matches/${matchId}/replay`, {
        token: await api.designer("designer-2"),
      });
      expect(outsider.statusCode).toBe(403);
    });
  });

  it("records feedback from seat holders on reached moments", async () => {
    await withApi(harness, async (api) => {
      const { owner, matchId, tokens } = await lobby(api, 2);
      const guest = ClaimInviteResponseSchema.parse(
        (await claim(api, tokens[0] ?? "", "Guest")).json(),
      );
      const send = (token: string | undefined, body: object) =>
        api.call("POST", `/api/matches/${matchId}/feedback`, { token, body });
      const created = await send(guest.guestToken, { seq: 0, body: "Setup looks right" });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ seq: 0, body: "Setup looks right" });
      const future = await send(guest.guestToken, { seq: 5, body: "Too early" });
      expect([future.statusCode, code(future)]).toEqual([400, "VALIDATION_FAILED"]);
      const ownerWithoutSeat = await send(owner, { seq: 0, body: "No seat" });
      expect([ownerWithoutSeat.statusCode, code(ownerWithoutSeat)]).toEqual([403, "FORBIDDEN"]);
      const empty = await send(guest.guestToken, { seq: 0, body: "" });
      expect(empty.statusCode).toBe(400);
    });
  });
});

describe("game creation stays user-only", () => {
  it("rejects guest tokens at designer routes", async () => {
    await withApi(harness, async (api) => {
      const { tokens } = await lobby(api);
      const guest = ClaimInviteResponseSchema.parse(
        (await claim(api, tokens[0] ?? "", "Guest")).json(),
      );
      for (const [method, url] of [
        ["GET", "/api/me"],
        ["GET", "/api/games"],
        ["POST", "/api/games"],
      ] as const) {
        const response = await api.call(method, url, {
          token: guest.guestToken,
          body:
            method === "POST"
              ? { slug: "guest-game", name: "G", visibility: "private" }
              : undefined,
        });
        expect([response.statusCode, code(response)], url).toEqual([403, "FORBIDDEN"]);
      }
      expect(createGame).toBeTypeOf("function");
    });
  });
});
