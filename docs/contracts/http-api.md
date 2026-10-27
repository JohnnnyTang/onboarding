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
