# T19 validation: CLI

Completed on 2026-11-06 on the `claude/t19-cli` branch, based on `3f8960a` (T18 merged).

## Delivered

- **`bgp init <dir>`** writes a starter package into an empty directory: a small, complete
  enforced card game (18 numbered cards, hidden hands and deck, opaque instance IDs,
  `countHidden` views, `legalMoves`, `invalid` messages, drag-to-play and an action button),
  its manifest and components (with an owner-visible `hand` zone), a README with the rules
  for game code, and placeholder card art drawn by the CLI as PNG, so the template holds no
  binary files. The id comes from the directory name or `--id`, the name from `--name`.
- **`bgp build`** bundles `src/index.ts` with esbuild into the manifest's `entry`: one ES
  module, no imports, at most 2 MB. An import-policy plugin enforces the `games/*` boundary:
  only `@bgp/rules` at run time, `@bgp/schema` for types (a runtime import is refused with
  advice), no relative imports outside the package, nothing else. `@bgp/rules` resolves from
  the CLI's own installation, so a bundle contains the SDK it is validated against and a
  package outside the workspace builds without installing anything (Q-028). Output is
  byte-identical for identical sources. Harbor Market's bundle is the same size as its
  package build.
- **`bgp validate`** runs, in order:
  1. The finalize checks that need no rules host, over the files a version would contain
     (components file, bundle, referenced assets): limits, paths, image signatures, no SVG or
     WASM, asset references by field path, sandbox owner seats, option defaults. These checks
     moved from `apps/server` into `@bgp/schema` (`version-files.ts`, `bundle-scan.ts`), so the
     server and the CLI report the same errors.
  2. The bundle is evaluated in worker threads locked down like the rules host: its list of
     globals throws when read (`Date`, `console`, timers, `process`, `fetch`, ...) and
     `Math.random` too; Node-only names QuickJS lacks read as `undefined`. Each trap records
     the name, so validate says "Game code used Math.random ...: use ctx.random". `crypto`
     traps game code (found by its frames on the call stack) but gives the runtime a
     digest-only object for `hashState`. The worker is bundled with production immer
     (`scripts/build-cli-worker.ts`), as the rules host bundles its runtime, so immer never
     reads the locked `process`.
  3. The default export must be a `GameDefinition`. Random-bot games (20 by default) cycle
     through every seat count from `players.min` to `players.max` with the default options,
     on up to four workers. Each game is replayed with `checkDeterminism`. At every step every
     seat and the spectator get `viewFor`, `present` and `actions`, checked by the generic
     leak rules (Q-027): valid tables, declared owner zones hidden from other seats, and no
     instance data or card definition in a view that its seat never saw face up while
     another seat sees it or nobody has. A watchdog stops a game that stays silent for 5 s
     (an endless loop); workers are capped at 512 MB.
     Harbor Market passes in about 10 s for 20 games; the starter game in about 2 s.
- **`bgp dev`** rebuilds on every change in the package and serves the latest build on
  `127.0.0.1` (contract: [dev-server.md](contracts/dev-server.md), `DevGameResponseSchema`
  and `DevBuildEventSchema` with JSON Schema export). The web app's new `/dev?game=<origin>`
  page accepts only a loopback `http:` origin, runs the bundle in the game worker under the
  usual lockdown, and on each build starts a fresh worker and replays the tab's match; a
  replay the new rules reject starts a new game with a notice, and a broken build keeps the
  last working table and lists the errors. The project hot-seat UI moved into a shared
  `HotSeatView`; new hot-seat games take the manifest's default options. The all-seats view
  is still the merge of seat snapshots (Q-021).
- **`bgp publish`** builds, runs the file checks, signs in with the OAuth device
  authorization grant (a link and a code for any browser; `BGP_TOKEN` for scripts; tokens
  are never printed or stored, Q-029) and runs the upload flow: find or create the game by
  the manifest id (`--visibility` when created), create a draft or resume an unfinished one,
  upload every file with its SHA-256, finalize, and compare the server's build hash with the
  local one. Identical files under a published version are a no-op; changed files under one
  are refused with advice to raise `version`. Every API response is validated with
  `@bgp/schema`. It prints the version id, build hash and the web app link for creating a
  match.
- **Keycloak:** public client `bgp-cli` with only the device grant and the `bgp-api`
  audience (`infra/keycloak/bgp-realm.json`); dev-environment.md says how to add it to a
  Keycloak started earlier.
- Harbor Market depends on `@bgp/cli` (`workspace:*`), so `pnpm --filter harbor-market exec
  bgp dev`, as dev-environment.md lists, works.

Also fixed on the way: the WASM inventory scan failed on esbuild's uninstalled optional
platform packages (pnpm lists them, sometimes under plain `dependencies`); a missing path is
now skipped only when every listing of it is optional by the parent's manifest. A recursion
in the import policy when bgp ran inside the package directory was caught while testing
`pnpm exec bgp` and has a regression test.

New dependency: `esbuild` 0.28.2 as a runtime dependency of `@bgp/cli` (tech-stack.md; native
binary, no WASM). Contract additions: dev-server.md (new, `protocol: 1`). No change to
existing contracts or protocol versions.

## Decisions and open questions

- **Q-021** updated: `bgp dev` keeps the merged all-seats view.
- **Q-027** (new): generic leak rules in `bgp validate`, their limits, and the alternative of
  a game-supplied oracle.
- **Q-028** (new): the SDK resolves from the CLI; no editor types outside the workspace until
  the packages are published.
- **Q-029** (new): device sign-in on every publish; no stored refresh token, no loopback
  browser sign-in yet.
- **Q-030** (new): how `/dev` reaches the dev server, and what T20's content security policy
  must allow for it.

## Validation

Run on Windows 11 with Node 24.12.0, PostgreSQL on port 15432 (a native PostgreSQL holds 5432
on this machine) and Keycloak 26.8.0 from the Compose file, with `bgp-cli` added through the
admin API because that Keycloak predates the realm change.

| Check                      | Result                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm typecheck`           | All tasks plus root tooling pass                                                                                                                                   |
| `pnpm lint`                | Biome and package-boundary checks pass                                                                                                                             |
| `pnpm test`                | 18 tasks and 69 tooling tests pass: 194 schema, 93 rules, 73 rules-host, 188 web, 109 server, 36 cli, 28 Harbor Market, 21 table-2d, 21 card-generator, 19 testing |
| `pnpm check:wasm`          | Passes; only the rules host's QuickJS module                                                                                                                       |
| `pnpm test:e2e` (Chromium) | 25 of 26 pass on the first full run; see below                                                                                                                     |
| `e2e/cli.spec.ts`          | Passes: the publish flow in Chromium, the `dev` flow in Chromium, Firefox and WebKit                                                                               |
| `e2e/projects.spec.ts`     | Passes in Firefox and WebKit as well (hot-seat after the `HotSeatView` move)                                                                                       |

The server count fell from 128 to 109 and the schema count rose from 175 to 194 because the
bundle-scan tests moved with the scanner.

The one failure in the full Chromium run was E2E-06 (`replay.spec.ts`): a scripted seat got
`INTERNAL` from the room server while playing the 300-event match. Run on its own it passed
twice in a row. This branch changes no room server or rules host code (only the pure upload
and finalize checks moved), so it looks like a timing flake under load, like the one T18
recorded; it is worth watching in CI.

**Done-when check.**

- **E2E-07** (`e2e/cli.spec.ts`): in a temporary directory, `bgp init` creates "CLI Duel";
  `bgp validate --games 6` passes with six finished games; `bgp build` writes `dist/game.js`;
  `bgp publish --visibility unlisted` shows the device link, the test signs in as designer2
  on Keycloak's device page and grants access, the CLI uploads and finalizes, and the API
  reports the version ready with the printed build hash; publishing again with `BGP_TOKEN`
  reports "already published with these files". In every browser, `bgp dev` serves the
  package to `/dev`: the test plays a card, edits `src/table.ts`, and the rebuilt table still
  shows "1 move so far" and the new prompt; a syntax error lists the build error while the
  table keeps running, and fixing it clears the alert.
- **A planted leak**: `packages/cli/test/validate.test.ts` edits the starter game's
  `playerView` to send another seat's hand, and in another test the deck; validate fails
  with "view carries instance … with all its data". The same edit in a copy of Harbor Market
  (whose cards live in an ID-keyed record) is caught too.
- **A planted `Math.random`**: the starter's shuffle replaced by `sort(() => Math.random() -
  0.5)` fails with "Game code used Math.random, which games may not use: use ctx.random (or
  random in setup) instead". Further tests cover `Date.now()` in a move, an endless move
  (stopped by the watchdog), nondeterminism through module state (caught by the replay), a
  missing asset, and the import policy.

## Not covered here

- Leaks the generic rules cannot see (partial redaction, identities encoded otherwise) need
  the game's own oracle-based leak tests (Q-027).
- `bgp validate` does not run the game in QuickJS; finalize does that on the server, and the
  worker's lockdown mirrors QuickJS's globals rather than its engine.
- No stored CLI credentials and no loopback browser sign-in (Q-029). No editor types for
  packages outside the workspace (Q-028).
- The content security policy for `/dev` is T20's (Q-030).
