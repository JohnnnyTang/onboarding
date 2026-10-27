import { describe, expect, test } from "vitest";
import { contractJsonSchemas, HTTP_CONTRACTS, HttpErrorSchema } from "../src/index.js";
import { hash, manifest, match } from "./fixtures.js";

describe("HTTP contracts and JSON Schema export", () => {
  test("validates all public response shapes", () => {
    const game = { id: "g1", slug: "harbor-market", name: "Harbor Market", visibility: "private" };
    const version = {
      id: "v1",
      gameId: "g1",
      manifest,
      status: "draft",
      buildHash: null,
      validationErrors: null,
    };
    const responses = [
      [HTTP_CONTRACTS["GET /api/healthz"].response, { ok: true }],
      [HTTP_CONTRACTS["GET /api/me"].response, { id: "u1", displayName: "Designer", email: null }],
      [HTTP_CONTRACTS["POST /api/games"].response, game],
      [HTTP_CONTRACTS["PATCH /api/games/:gameId"].response, game],
      [HTTP_CONTRACTS["GET /api/games"].response, { items: [game], cursor: null }],
      [HTTP_CONTRACTS["GET /api/games/:gameId"].response, { ...game, versions: [version] }],
      [HTTP_CONTRACTS["POST /api/games/:gameId/versions"].response, version],
      [HTTP_CONTRACTS["POST /api/versions/:versionId/finalize"].response, { buildHash: hash }],
      [
        HTTP_CONTRACTS["POST /api/matches"].response,
        { match, invites: [{ seat: "0", url: "/join/token" }] },
      ],
      [HTTP_CONTRACTS["GET /api/matches"].response, { items: [match], cursor: null }],
      [HTTP_CONTRACTS["GET /api/matches/:matchId"].response, match],
      [HTTP_CONTRACTS["POST /api/matches/:matchId/start"].response, match],
      [
        HTTP_CONTRACTS["POST /api/matches/:matchId/abandon"].response,
        { ...match, status: "abandoned" },
      ],
      [HTTP_CONTRACTS["POST /api/invites/:token/claim"].response, { matchId: "m1", seat: "0" }],
      [
        HTTP_CONTRACTS["GET /api/matches/:matchId/replay"].response,
        { buildHash: hash, seats: ["0"], seed: 1, options: {}, events: [] },
      ],
      [
        HTTP_CONTRACTS["POST /api/matches/:matchId/feedback"].response,
        { id: "f1", seq: 0, body: "Useful", createdAt: "2026-10-27T12:00:00Z" },
      ],
    ] as const;
    for (const [schema, value] of responses) expect(schema.parse(value)).toEqual(value);
    expect(
      HTTP_CONTRACTS["POST /api/games/:gameId/versions"].response.safeParse({
        ...version,
        status: "ready",
      }).success,
    ).toBe(false);
    expect(
      HTTP_CONTRACTS["GET /api/matches/:matchId"].response.safeParse({ ...match, seed: 123 })
        .success,
    ).toBe(false);
  });
  test("all documented endpoints have a contract", () => {
    expect(Object.keys(HTTP_CONTRACTS)).toHaveLength(18);
    for (const [route, contract] of Object.entries(HTTP_CONTRACTS)) {
      expect("response" in contract || route.includes("/files/*")).toBe(true);
    }
  });
  test("validates every documented JSON request body", () => {
    const requests = [
      [
        HTTP_CONTRACTS["POST /api/games"].body,
        { slug: "harbor-market", name: "Harbor Market", visibility: "private" },
      ],
      [HTTP_CONTRACTS["PATCH /api/games/:gameId"].body, { visibility: "unlisted" }],
      [HTTP_CONTRACTS["POST /api/games/:gameId/versions"].body, manifest],
      [HTTP_CONTRACTS["POST /api/matches"].body, { versionId: "v1", seatCount: 2, options: {} }],
      [HTTP_CONTRACTS["POST /api/invites/:token/claim"].body, { displayName: "Guest" }],
      [HTTP_CONTRACTS["POST /api/matches/:matchId/feedback"].body, { seq: 0, body: "Useful" }],
      [HTTP_CONTRACTS["POST /api/versions/:versionId/finalize"].body, {}],
      [HTTP_CONTRACTS["POST /api/matches/:matchId/start"].body, {}],
      [HTTP_CONTRACTS["POST /api/matches/:matchId/abandon"].body, {}],
    ] as const;
    for (const [schema, input] of requests) expect(schema.parse(input)).toEqual(input);
  });
  test("enforces visibility, limits, safe uploads and error fields", () => {
    expect(
      HTTP_CONTRACTS["POST /api/games"].body.safeParse({
        slug: "harbor-market",
        name: "Game",
        visibility: "public",
      }).success,
    ).toBe(false);
    expect(HTTP_CONTRACTS["PATCH /api/games/:gameId"].body.safeParse({}).success).toBe(false);
    expect(
      HTTP_CONTRACTS["POST /api/matches"].body.safeParse({
        versionId: "v1",
        seatCount: 2,
        options: {},
        seed: 1,
      }).success,
    ).toBe(false);
    expect(
      HTTP_CONTRACTS["PUT /api/versions/:versionId/files/*"].headers.parse({
        "x-content-sha256": hash,
        "content-type": "image/png",
      }),
    ).toEqual({ "x-content-sha256": hash });
    expect(
      HTTP_CONTRACTS["PUT /api/versions/:versionId/files/*"].params.safeParse({
        versionId: "v1",
        path: "evil.wasm",
      }).success,
    ).toBe(false);
    expect(
      HttpErrorSchema.parse({
        error: {
          code: "VALIDATION_FAILED",
          message: "Invalid package",
          errors: [{ path: "defs.0.front", message: "Missing image" }],
        },
      }),
    ).toBeDefined();
    expect(
      HttpErrorSchema.safeParse({ error: { code: "INTERNAL", message: "Oops", state: {} } })
        .success,
    ).toBe(false);
    expect(
      HTTP_CONTRACTS["GET /api/matches/:matchId/replay"].response.parse({
        buildHash: hash,
        seats: ["0", "1"],
        seed: 123,
        options: {},
        events: [],
      }),
    ).toBeDefined();
    expect(HTTP_CONTRACTS["GET /api/games"].query.safeParse({ limit: 201 }).success).toBe(false);
    expect(HTTP_CONTRACTS["GET /api/games"].query.safeParse({ limit: "50" }).success).toBe(false);
  });
  test("exports structural schemas without weakening unrepresentable types", () => {
    const schemas = contractJsonSchemas();
    for (const key of [
      "JsonSchema",
      "MatchStateSchema",
      "ComponentsFileSchema",
      "TableSnapshotSchema",
      "ManifestSchema",
      "ClientMessageSchema",
      "ServerMessageSchema",
      "HttpErrorSchema",
      "ReplayResponseSchema",
    ]) {
      expect(schemas[key]?.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    }
    expect(schemas.GameDefinitionSchema).toBeUndefined();
    expect(schemas.IntegerSchema).toMatchObject({
      type: "integer",
      minimum: Number.MIN_SAFE_INTEGER,
      maximum: Number.MAX_SAFE_INTEGER,
    });
    expect(schemas.ClientViewSchema).toMatchObject({ additionalProperties: false });
    expect(JSON.stringify(schemas.JsonSchema)).not.toContain('"type":"number"');
  });
});
