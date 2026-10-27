# Contract: HTTP API

REST endpoints under `/api`, served by Fastify in `apps/server`. Request and response bodies are JSON validated with `@bgp/schema`, except file uploads and downloads.

## Authentication

- **Designers:** `Authorization: Bearer <OIDC access token>`. The server verifies it against the issuer's JWKS and creates the `users` row on first sight.
- **Guests:** `Authorization: Bearer <guest token>`, issued by claiming an invite. A guest token is a JWT signed by the server (`GUEST_TOKEN_SECRET`), scoped to one match and one seat, valid for 30 days.
- No authentication cookies (D-007).

## Errors

Non-2xx responses have the body `{ "error": { "code": "<code>", "message": "...", "errors"?: [...] } }` with codes from [protocol.md](protocol.md#error-codes).

## Endpoints

| Method and path                          | Auth                                               | Purpose                                                                                                                                                |
| ---------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/healthz`                       | none                                               | Liveness                                                                                                                                               |
| `GET /api/me`                            | user                                               | Current user                                                                                                                                           |
| `GET /api/games`                         | user                                               | Games owned by the user                                                                                                                                |
| `POST /api/games`                        | user                                               | Create a game: `{ slug, name, visibility }`                                                                                                            |
| `GET /api/games/:gameId`                 | owner                                              | Game with its versions                                                                                                                                 |
| `PATCH /api/games/:gameId`               | owner                                              | Rename or change visibility (`private` or `unlisted` in Phase 1)                                                                                       |
| `POST /api/games/:gameId/versions`       | owner                                              | Create a draft version from a manifest ([manifest.md](manifest.md#upload-flow))                                                                        |
| `PUT /api/versions/:versionId/files/*`   | owner                                              | Upload one file; header `x-content-sha256`                                                                                                             |
| `POST /api/versions/:versionId/finalize` | owner                                              | Validate and mark ready; returns the build hash                                                                                                        |
| `GET /api/versions/:versionId/files/*`   | owner, or a seat holder in a match of this version | Download a file; `Cache-Control: immutable` for ready versions                                                                                         |
| `POST /api/matches`                      | user                                               | Create a match: `{ versionId, seatCount, options }` → match plus one invite link per seat                                                              |
| `GET /api/matches`                       | user                                               | Matches the user created or plays in                                                                                                                   |
| `GET /api/matches/:matchId`              | owner or seat holder                               | Match summary, seats, status                                                                                                                           |
| `POST /api/matches/:matchId/start`       | owner                                              | Start when at least `players.min` seats are filled                                                                                                     |
| `POST /api/matches/:matchId/abandon`     | owner                                              | End without a result                                                                                                                                   |
| `POST /api/invites/:token/claim`         | none or user                                       | Claim a seat: `{ displayName }` → `{ matchId, seat, guestToken? }`. A signed-in user binds the seat to their account instead of getting a guest token. |
| `GET /api/matches/:matchId/replay`       | owner or seat holder, finished matches only        | `{ buildHash, seats, seed, options, events: AcceptedEvent[] }`                                                                                         |
| `POST /api/matches/:matchId/feedback`    | owner or seat holder                               | Stretch goal: `{ seq, body }` comment on a moment                                                                                                      |

## Notes

- The match seed is generated by the server (cryptographically random 32-bit integer) and revealed only through the replay endpoint after the match finishes, because seed plus intents reveals every hidden card.
- Invite tokens are random 128-bit values; only their SHA-256 is stored.
- List endpoints accept `?limit` (default 50, max 200) and `?cursor`.

## JSON body shapes

T02 makes the previously unnamed response shapes explicit. Public resource IDs are
strings (database IDs are UUIDs). `MatchSummary` and `SeatInfo` have the protocol shapes;
the summary never includes a seed, RNG or authoritative state. Both lobby and active
matches reference a ready version and its build hash.

| Name                | Shape                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ValidationError     | `{ path: string, message: string }` (`path` is a field or file path)                                                                                              |
| UserResponse        | `{ id, displayName, email: string \| null }`                                                                                                                      |
| GameResponse        | `{ id, slug, name, visibility: "private" \| "unlisted" }`                                                                                                         |
| VersionResponse     | `{ id, gameId, manifest, status: "draft" \| "ready" \| "failed", buildHash: string \| null, validationErrors: ValidationError[] \| null }`; ready requires a hash |
| GameDetailResponse  | `GameResponse` plus `{ versions: VersionResponse[] }`                                                                                                             |
| GameListResponse    | `{ items: GameResponse[], cursor: string \| null }`                                                                                                               |
| MatchListResponse   | `{ items: MatchSummary[], cursor: string \| null }`                                                                                                               |
| CreateMatchResponse | `{ match: MatchSummary, invites: { seat, url: string }[] }`                                                                                                       |
| FinalizeResponse    | `{ buildHash }`                                                                                                                                                   |
| FeedbackResponse    | `{ id, seq, body, createdAt: ISO time }`                                                                                                                          |

Health returns `{ ok: true }`. Creating/updating a game returns `GameResponse`; creating
a draft returns `VersionResponse`; getting a game returns `GameDetailResponse`.
Getting, starting or abandoning a match returns `MatchSummary`. List, finalize, create
match and feedback endpoints return their corresponding shapes above. Invite claim and
replay responses are the shapes already listed in the endpoint table. Raw file upload
success has no JSON body; downloads are raw files. Start, abandon and finalize have no
request data (an omitted body or `{}`); HTTP adapters normalize an omitted body to `{}`.
`HTTP_CONTRACTS` maps each endpoint to its JSON validators, including query and upload
header/file-path validators. All endpoints use `HttpErrorSchema` for errors.

Game names and display names are 1–80 characters. Feedback is 1–2,000 characters with a
nonnegative sequence. Match seat counts are 1–8 and must also fit the version's range
(checked in T10). Empty game patches and unknown fields are rejected. Hashes are 64
lowercase hex characters. HTTP query decoding, authentication, file contents, upload
limits and match-specific constraints remain server responsibilities.

<!-- schema: CreateGameBodySchema -->
```json
{ "slug": "harbor-market", "name": "Harbor Market", "visibility": "private" }
```

<!-- schema: CreateMatchBodySchema -->
```json
{ "versionId": "version-1", "seatCount": 3, "options": { "shortGame": false } }
```

<!-- schema: ClaimInviteResponseSchema -->
```json
{ "matchId": "match-1", "seat": "0", "guestToken": "guest-token" }
```

<!-- schema: HttpErrorSchema -->
```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Invalid package",
    "errors": [{ "path": "defs.0.front", "message": "Missing image" }]
  }
}
```
