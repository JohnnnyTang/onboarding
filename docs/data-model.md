# Data model

PostgreSQL tables (Drizzle schema in `apps/server/src/db/schema.ts`), object storage keys, and the browser's IndexedDB stores. All timestamps are `timestamptz` in UTC. IDs are UUID v7 unless stated.

## PostgreSQL

### `users`

| Column         | Type        | Notes                              |
| -------------- | ----------- | ---------------------------------- |
| `id`           | uuid, PK    |                                    |
| `oidc_issuer`  | text        |                                    |
| `oidc_subject` | text        | Unique together with `oidc_issuer` |
| `display_name` | text        |                                    |
| `email`        | text, null  | From the token if present          |
| `created_at`   | timestamptz |                                    |

### `games`

| Column                     | Type                                 | Notes                                |
| -------------------------- | ------------------------------------ | ------------------------------------ |
| `id`                       | uuid, PK                             |                                      |
| `owner_id`                 | uuid → `users.id`                    |                                      |
| `slug`                     | text, unique                         | Equals manifest `id`                 |
| `name`                     | text                                 |                                      |
| `visibility`               | enum `private`, `unlisted`, `public` | `public` rejected in Phase 1 (D-008) |
| `created_at`, `updated_at` | timestamptz                          |                                      |

### `game_versions`

| Column                       | Type                            | Notes                                            |
| ---------------------------- | ------------------------------- | ------------------------------------------------ |
| `id`                         | uuid, PK                        |                                                  |
| `game_id`                    | uuid → `games.id`               |                                                  |
| `version`                    | text                            | Semantic version; unique together with `game_id` |
| `mode`                       | enum `enforced`, `sandbox`      |                                                  |
| `status`                     | enum `draft`, `ready`, `failed` |                                                  |
| `manifest`                   | jsonb                           | Validated `bgp.json`                             |
| `build_hash`                 | text, unique, null until ready  | [manifest.md](contracts/manifest.md#upload-flow) |
| `validation_errors`          | jsonb, null                     | Set when `failed`                                |
| `created_at`, `finalized_at` | timestamptz                     |                                                  |

### `version_files`

| Column         | Type                      | Notes                        |
| -------------- | ------------------------- | ---------------------------- |
| `version_id`   | uuid → `game_versions.id` | PK with `path`               |
| `path`         | text                      | Relative path in the version |
| `sha256`       | text                      | Blob key is `blobs/<sha256>` |
| `bytes`        | integer                   |                              |
| `content_type` | text                      |                              |

### `matches`

| Column                                    | Type                                            | Notes                                  |
| ----------------------------------------- | ----------------------------------------------- | -------------------------------------- |
| `id`                                      | uuid, PK                                        |                                        |
| `version_id`                              | uuid → `game_versions.id`                       | Must be `ready`                        |
| `created_by`                              | uuid → `users.id`                               | The match owner                        |
| `status`                                  | enum `lobby`, `active`, `finished`, `abandoned` |                                        |
| `seat_count`                              | integer                                         | Within `players.min..max`              |
| `seed`                                    | bigint                                          | 32-bit unsigned; secret until finished |
| `options`                                 | jsonb                                           | Validated against manifest options     |
| `last_seq`                                | integer, default 0                              | Highest stored event                   |
| `result`                                  | jsonb, null                                     | `GameResult`                           |
| `created_at`, `started_at`, `finished_at` | timestamptz                                     |                                        |

### `match_seats`

| Column              | Type                    | Notes                            |
| ------------------- | ----------------------- | -------------------------------- |
| `match_id`          | uuid → `matches.id`     | PK with `seat`                   |
| `seat`              | text                    | `"0"`, `"1"`, …                  |
| `user_id`           | uuid → `users.id`, null | Set when a signed-in user claims |
| `display_name`      | text, null              | Set on claim                     |
| `is_guest`          | boolean                 |                                  |
| `invite_token_hash` | text, unique            | SHA-256 of the invite token      |
| `claimed_at`        | timestamptz, null       |                                  |

### `match_events` (append-only)

| Column       | Type                | Notes                    |
| ------------ | ------------------- | ------------------------ |
| `match_id`   | uuid → `matches.id` | PK with `seq`            |
| `seq`        | integer             | 1-based, no gaps         |
| `seat`       | text                |                          |
| `intent`     | jsonb               | `MoveIntent` as accepted |
| `created_at` | timestamptz         |                          |

Never update or delete rows. Insert in the same transaction that bumps `matches.last_seq`.

### `match_snapshots`

| Column       | Type                | Notes                                       |
| ------------ | ------------------- | ------------------------------------------- |
| `match_id`   | uuid → `matches.id` | PK with `seq`                               |
| `seq`        | integer             | Snapshot after this event (0 = after setup) |
| `state`      | jsonb               | Full `MatchState`; server-only              |
| `state_hash` | text                | `hashState(state)`                          |
| `created_at` | timestamptz         |                                             |

Write one at `seq = 0`, every 50 events, and at the end. Recovery loads the latest snapshot and replays later events, then checks hashes where available.

### `match_feedback` (stretch goal)

| Column       | Type                | Notes                            |
| ------------ | ------------------- | -------------------------------- |
| `id`         | uuid, PK            |                                  |
| `match_id`   | uuid → `matches.id` |                                  |
| `seq`        | integer             | The moment the comment refers to |
| `seat`       | text                | Author's seat                    |
| `body`       | text                | ≤ 2,000 characters               |
| `created_at` | timestamptz         |                                  |

## Object storage (`BlobStore`)

| Key              | Content                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `blobs/<sha256>` | Any uploaded file (bundles, images, components files), content-addressed and deduplicated |

The rules host reads bundles from a local cache directory, `<BUNDLE_CACHE_DIR>/<buildHash>/game.js`, which the server fills from `BlobStore` before starting a match.

## Browser IndexedDB (`bgp` database)

| Store            | Key                 | Value                                                                                                 |
| ---------------- | ------------------- | ----------------------------------------------------------------------------------------------------- |
| `projects`       | `id` (UUID)         | `{ id, name, mode, manifest, components, cardTemplates, csvSources, updatedAt, publishedVersionIds }` |
| `projectAssets`  | `[projectId, path]` | `{ projectId, path, blob, sha256, contentType }`                                                      |
| `hotseatMatches` | `id`                | `{ id, projectId, init: { seats, seed, options }, events: AcceptedEvent[], updatedAt }`               |

Hot-seat matches store only init plus events; the state is rebuilt with `replay`.
