# T10 validation: HTTP API

Completed on 2026-11-03 on the `t10-http-api` branch, based on `c33924c`
(T08 complete, D-008 accepted).

## Delivered

- `buildApp` in `apps/server` assembles Fastify with the T09 auth plugin, the
  documented error envelope, CORS for `PUBLIC_WEB_ORIGIN` without credentials, and
  every endpoint in [http-api.md](contracts/http-api.md), including the stretch
  feedback endpoint. `src/main.ts` is the runnable server (`pnpm dev` watches it).
- `BlobStore` with an `fs` driver (atomic rename, content-addressed `blobs/<sha256>`)
  and an S3 driver on `@aws-sdk/client-s3` 3.1154.0, recorded in tech-stack.md.
- The manifest.md upload flow. Uploads are checked on arrival (hash, WASM by path and
  content, SVG, image signatures and sizes, bundle size, file and byte limits).
  Finalize collects every structural error, then runs `setup` in the real QuickJS
  rules host for `players.min` and `players.max` through a `BuildStore` that serves
  staged builds during finalize and ready versions from PostgreSQL and the BlobStore.
- Matches with a cryptographically random 32-bit seed and one 128-bit invite per seat,
  stored only as SHA-256. Claims, start, abandon, replay and feedback follow the rules
  now written down in http-api.md ("Server behavior (T10)").
- Migration `0002`: `build_hash` is no longer unique, so identical re-uploads share a
  hash (AC-02); a check ties the hash to `ready`; `(match_id, user_id)` is unique.

## Checks

| Command                          | Evidence                                                             |
| -------------------------------- | -------------------------------------------------------------------- |
| `pnpm build`                     | 10 build tasks pass                                                  |
| `pnpm typecheck`                 | 17 tasks plus root tooling pass                                      |
| `pnpm lint`                      | Biome and package-boundary checks pass                               |
| `pnpm test`                      | 17 tasks and 48 root tooling tests pass                              |
| `pnpm --filter @bgp/server test` | 103 tests in 10 files, against `bgp_test` and the real rules host    |
| `pnpm check:wasm`                | Passes; the S3 SDK adds no WASM (only the QuickJS module is present) |

INT-UPLOAD (`apps/server/test/int-upload.test.ts`) publishes Harbor Market's real
`dist/game.js` and components, runs `setup` in the rules host, and re-publishes the
same files as `0.1.1`: both versions are ready with the same build hash, which also
equals an independent computation of the manifest.md formula. Corrupt hash, missing
asset, `.wasm` (by path and disguised by content), SVG (in components and as an
upload), and a bundle with an `import` statement each fail with `VALIDATION_FAILED`
and a specific error. A bundle whose `setup` throws fails once per player count.

Every endpoint has a success test and a permission test (wrong designer, guest at a
user route, guest of another match, or anonymous). Tests read the stored seat rows to
show that only invite hashes are kept, and they assert that create, read, list, claim
and start responses contain neither a `seed` field nor the seed value; the seed appears
only in the replay of a finished match.

A smoke run of the built server (`node dist/main.js`) against the local database
served `/api/healthz` and returned the error envelope for `/api/me` without a token.

## Not covered here

- The S3 driver is tested with a fake client for command shapes and 404 mapping; no S3
  service was run. The provider stays open (Q-002).
- A live Keycloak access token was not used: the realm disables password grants, and
  the browser PKCE flow belongs to T12's Playwright test. T09's tests verify real
  RS256 signatures against a JWKS endpoint.
- Sandbox versions are checked structurally at finalize; running their setup is left to
  however T11 hosts sandbox matches (Q-014).
- Presence (`connected`) is always `false` until T11.

New open questions: Q-013 (starting with fewer players than seats), Q-014 (sandbox
setup check), Q-015 (unused `BUNDLE_CACHE_DIR` and `RULES_HOST_PROCESSES`). Q-005 is
resolved.
