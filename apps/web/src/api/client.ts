import {
  type ClaimInviteBody,
  type ClaimInviteResponse,
  ClaimInviteResponseSchema,
  type CreateGameBody,
  type CreateMatchBody,
  type CreateMatchResponse,
  CreateMatchResponseSchema,
  type ErrorCode,
  type FinalizeResponse,
  FinalizeResponseSchema,
  type GameDetailResponse,
  GameDetailResponseSchema,
  type GameListResponse,
  GameListResponseSchema,
  type GameResponse,
  GameResponseSchema,
  HTTP_CONTRACTS,
  HttpErrorSchema,
  type ListQuery,
  type Manifest,
  type MatchListResponse,
  MatchListResponseSchema,
  type MatchSummary,
  MatchSummarySchema,
  type ReplayResponse,
  ReplayResponseSchema,
  type UpdateGameBody,
  type ValidationError,
  type VersionResponse,
  VersionResponseSchema,
} from "@bgp/schema";

/** A documented error envelope from the server (contracts/http-api.md#errors). */
export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly errors: readonly ValidationError[] = [],
  ) {
    super(message);
  }
}

/**
 * The server answered with something that is not the documented shape. The body is not
 * kept: it is untrusted and may be large.
 */
export class UnexpectedResponseError extends Error {
  override readonly name = "UnexpectedResponseError";
  constructor(
    readonly status: number,
    readonly endpoint: string,
  ) {
    super(`Unexpected response from ${endpoint} (HTTP ${status})`);
  }
}

/** What a request is about, so the caller can pick a guest token for a match. */
export interface TokenScope {
  matchId?: string;
}

export interface TokenSource {
  /** Bearer token for this request, or null for an anonymous call. */
  tokenFor(scope: TokenScope): string | null;
}

export interface ApiClientOptions {
  /** API origin without `/api`, e.g. `http://localhost:3000`. */
  baseUrl: string;
  tokens: TokenSource;
  fetch?: typeof fetch;
}

interface Parser<T> {
  parse(value: unknown): T;
}

interface RequestOptions<T> {
  endpoint: keyof typeof HTTP_CONTRACTS;
  path: string;
  response: Parser<T>;
  scope?: TokenScope;
  query?: ListQuery;
  body?: unknown;
}

export interface ApiClient {
  listGames(query?: ListQuery): Promise<GameListResponse>;
  getGame(gameId: string): Promise<GameDetailResponse>;
  listMatches(query?: ListQuery): Promise<MatchListResponse>;
  getMatch(matchId: string): Promise<MatchSummary>;
  /** Seed, seats and accepted events of a finished match, with the stored final hash. */
  getReplay(matchId: string): Promise<ReplayResponse>;
  claimInvite(token: string, body: ClaimInviteBody): Promise<ClaimInviteResponse>;
  /** A version and its manifest; `scope` picks the guest token of a match of this version. */
  getVersion(versionId: string, scope?: TokenScope): Promise<VersionResponse>;
  /** One raw file of a version (bundle, components file, image). */
  getVersionFile(versionId: string, path: string, scope?: TokenScope): Promise<Blob>;
  createGame(body: CreateGameBody): Promise<GameResponse>;
  updateGame(gameId: string, body: UpdateGameBody): Promise<GameResponse>;
  /** A draft version from a manifest (contracts/manifest.md#upload-flow). */
  createVersion(gameId: string, manifest: Manifest): Promise<VersionResponse>;
  /** Uploads one file of a draft; `sha256` is the lowercase hex digest of `body`. */
  uploadVersionFile(versionId: string, path: string, body: Blob, sha256: string): Promise<void>;
  finalizeVersion(versionId: string): Promise<FinalizeResponse>;
  createMatch(body: CreateMatchBody): Promise<CreateMatchResponse>;
  startMatch(matchId: string): Promise<MatchSummary>;
  abandonMatch(matchId: string): Promise<MatchSummary>;
}

const segment = (value: string) => encodeURIComponent(value);

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const base = options.baseUrl.replace(/\/$/, "");

  async function failure(response: Response, endpoint: string): Promise<Error> {
    const parsed = HttpErrorSchema.safeParse(await readJson(response));
    if (!parsed.success) return new UnexpectedResponseError(response.status, endpoint);
    const { code, message, errors } = parsed.data.error;
    return new ApiError(response.status, code, message, errors ?? []);
  }

  function filePath(
    endpoint: "GET /api/versions/:versionId/files/*" | "PUT /api/versions/:versionId/files/*",
    versionId: string,
    path: string,
  ): URL {
    const params = HTTP_CONTRACTS[endpoint].params.parse({ versionId, path });
    const encoded = params.path.split("/").map(segment).join("/");
    return new URL(`${base}/api/versions/${segment(params.versionId)}/files/${encoded}`);
  }

  function authorization(scope: TokenScope): Record<string, string> {
    const token = options.tokens.tokenFor(scope);
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  async function request<T>(spec: RequestOptions<T>): Promise<T> {
    const contract: Readonly<Record<string, Parser<unknown> | undefined>> =
      HTTP_CONTRACTS[spec.endpoint];
    const url = new URL(`${base}${spec.path}`);
    if (spec.query && contract.query) {
      const query = contract.query.parse(spec.query) as ListQuery;
      if (query.limit !== undefined) url.searchParams.set("limit", String(query.limit));
      if (query.cursor !== undefined) url.searchParams.set("cursor", query.cursor);
    }
    const headers: Record<string, string> = {
      accept: "application/json",
      ...authorization(spec.scope ?? {}),
    };
    let body: string | undefined;
    if (spec.body !== undefined) {
      // Validate outgoing bodies too, so contract drift fails here and not on the server.
      body = JSON.stringify(contract.body ? contract.body.parse(spec.body) : spec.body);
      headers["content-type"] = "application/json";
    }
    const method = spec.endpoint.slice(0, spec.endpoint.indexOf(" "));
    // Bearer tokens only (D-007): never send cookies to the API.
    const response = await fetchImpl(url, {
      method,
      headers,
      credentials: "omit",
      ...(body === undefined ? {} : { body }),
    });
    if (!response.ok) throw await failure(response, spec.endpoint);
    const json = await readJson(response);
    try {
      return spec.response.parse(json);
    } catch {
      throw new UnexpectedResponseError(response.status, spec.endpoint);
    }
  }

  return {
    listGames: (query) =>
      request({
        endpoint: "GET /api/games",
        path: "/api/games",
        response: GameListResponseSchema,
        ...(query ? { query } : {}),
      }),
    getGame: (gameId) =>
      request({
        endpoint: "GET /api/games/:gameId",
        path: `/api/games/${segment(gameId)}`,
        response: GameDetailResponseSchema,
      }),
    listMatches: (query) =>
      request({
        endpoint: "GET /api/matches",
        path: "/api/matches",
        response: MatchListResponseSchema,
        ...(query ? { query } : {}),
      }),
    getMatch: (matchId) =>
      request({
        endpoint: "GET /api/matches/:matchId",
        path: `/api/matches/${segment(matchId)}`,
        response: MatchSummarySchema,
        scope: { matchId },
      }),
    getReplay: (matchId) =>
      request({
        endpoint: "GET /api/matches/:matchId/replay",
        path: `/api/matches/${segment(matchId)}/replay`,
        response: ReplayResponseSchema,
        scope: { matchId },
      }),
    claimInvite: (token, body) =>
      request({
        endpoint: "POST /api/invites/:token/claim",
        path: `/api/invites/${segment(token)}/claim`,
        response: ClaimInviteResponseSchema,
        body,
      }),
    getVersion: (versionId, scope) =>
      request({
        endpoint: "GET /api/versions/:versionId",
        path: `/api/versions/${segment(versionId)}`,
        response: VersionResponseSchema,
        ...(scope ? { scope } : {}),
      }),
    async getVersionFile(versionId, path, scope = {}) {
      const endpoint = "GET /api/versions/:versionId/files/*";
      const response = await fetchImpl(filePath(endpoint, versionId, path), {
        method: "GET",
        headers: authorization(scope),
        credentials: "omit",
      });
      if (!response.ok) throw await failure(response, endpoint);
      return response.blob();
    },
    createGame: (body) =>
      request({
        endpoint: "POST /api/games",
        path: "/api/games",
        response: GameResponseSchema,
        body,
      }),
    updateGame: (gameId, body) =>
      request({
        endpoint: "PATCH /api/games/:gameId",
        path: `/api/games/${segment(gameId)}`,
        response: GameResponseSchema,
        body,
      }),
    createVersion: (gameId, manifest) =>
      request({
        endpoint: "POST /api/games/:gameId/versions",
        path: `/api/games/${segment(gameId)}/versions`,
        response: VersionResponseSchema,
        body: manifest,
      }),
    async uploadVersionFile(versionId, path, body, sha256) {
      const endpoint = "PUT /api/versions/:versionId/files/*";
      const headers = HTTP_CONTRACTS[endpoint].headers.parse({ "x-content-sha256": sha256 });
      const response = await fetchImpl(filePath(endpoint, versionId, path), {
        method: "PUT",
        headers: {
          ...headers,
          "content-type": "application/octet-stream",
          ...authorization({}),
        },
        credentials: "omit",
        body,
      });
      if (!response.ok) throw await failure(response, endpoint);
    },
    finalizeVersion: (versionId) =>
      request({
        endpoint: "POST /api/versions/:versionId/finalize",
        path: `/api/versions/${segment(versionId)}/finalize`,
        response: FinalizeResponseSchema,
        body: {},
      }),
    createMatch: (body) =>
      request({
        endpoint: "POST /api/matches",
        path: "/api/matches",
        response: CreateMatchResponseSchema,
        body,
      }),
    startMatch: (matchId) =>
      request({
        endpoint: "POST /api/matches/:matchId/start",
        path: `/api/matches/${segment(matchId)}/start`,
        response: MatchSummarySchema,
        body: {},
      }),
    abandonMatch: (matchId) =>
      request({
        endpoint: "POST /api/matches/:matchId/abandon",
        path: `/api/matches/${segment(matchId)}/abandon`,
        response: MatchSummarySchema,
        body: {},
      }),
  };
}
