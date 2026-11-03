import {
  type ClaimInviteBody,
  type ClaimInviteResponse,
  ClaimInviteResponseSchema,
  type ErrorCode,
  type GameDetailResponse,
  GameDetailResponseSchema,
  type GameListResponse,
  GameListResponseSchema,
  HTTP_CONTRACTS,
  HttpErrorSchema,
  type ListQuery,
  type MatchListResponse,
  MatchListResponseSchema,
  type MatchSummary,
  MatchSummarySchema,
  type ValidationError,
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
  claimInvite(token: string, body: ClaimInviteBody): Promise<ClaimInviteResponse>;
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

  async function request<T>(spec: RequestOptions<T>): Promise<T> {
    const contract: Readonly<Record<string, Parser<unknown> | undefined>> =
      HTTP_CONTRACTS[spec.endpoint];
    const url = new URL(`${base}${spec.path}`);
    if (spec.query && contract.query) {
      const query = contract.query.parse(spec.query) as ListQuery;
      if (query.limit !== undefined) url.searchParams.set("limit", String(query.limit));
      if (query.cursor !== undefined) url.searchParams.set("cursor", query.cursor);
    }
    const headers: Record<string, string> = { accept: "application/json" };
    const token = options.tokens.tokenFor(spec.scope ?? {});
    if (token) headers.authorization = `Bearer ${token}`;
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
    const json = await readJson(response);
    if (!response.ok) {
      const parsed = HttpErrorSchema.safeParse(json);
      if (!parsed.success) throw new UnexpectedResponseError(response.status, spec.endpoint);
      const { code, message, errors } = parsed.data.error;
      throw new ApiError(response.status, code, message, errors ?? []);
    }
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
    claimInvite: (token, body) =>
      request({
        endpoint: "POST /api/invites/:token/claim",
        path: `/api/invites/${segment(token)}/claim`,
        response: ClaimInviteResponseSchema,
        body,
      }),
  };
}
