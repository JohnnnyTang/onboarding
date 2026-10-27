# T01 validation

Validated locally on 2026-10-27, Windows, with Node 24.22.1 and pnpm 11.9.0.

## Delivered

- Ten empty ESM workspace packages matching the architecture, each with a passing placeholder test.
- Exact tooling pins, a frozen lockfile, strict shared TypeScript configuration and separate environment libraries.
- Turborepo build, typecheck, test and dev tasks; every root command from AGENTS.md.
- Biome lint/format, restricted imports and an AST-based boundary guard with tests.
- Empty WASM inventory, production dependency/output scan and rejection tests.
- Environment examples, generated-file ignores, CI and nightly browser-matrix workflow.
- Development instructions, installed version records and explicit pending-task commands.

## Checks

A fresh source copy excluded dependencies, build outputs, caches and local tools. It used
the exact `.nvmrc` Node binary and `pnpm install --frozen-lockfile --offline` against the
already populated package store. No dependencies were resolved or downloaded in that run.

| Check                                                          | Result                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------- |
| Frozen install in the working directory                        | Pass                                                    |
| Frozen offline install in a fresh source copy                  | Pass                                                    |
| `pnpm lint` in the fresh copy                                  | Pass                                                    |
| `pnpm typecheck` in the fresh copy                             | Pass                                                    |
| `pnpm test` in the fresh copy                                  | Pass: 10 package tests and 29 tooling tests             |
| `pnpm build` in the fresh copy                                 | Pass: all 10 packages                                   |
| `pnpm check:wasm` in the fresh copy                            | Pass: 0 modules                                         |
| Chromium harness in the fresh copy                             | Pass: 1 test                                            |
| Temporarily importing `pixi.js` from rules                     | `pnpm lint` fails with the restricted-import diagnostic |
| Temporarily planting an unlisted `.wasm` in rules build output | `pnpm check:wasm` fails and reports its path and size   |
| `pnpm dev` startup and shutdown                                | Both scaffold watchers start; Ctrl+C stops them         |
| `pnpm db:migrate` before T07                                   | Nonzero exit with an explicit T07 message               |

The tooling tests also cover relative imports across packages, re-exports, dynamic imports,
worker-only rules imports, pure-code globals, transitive production WASM, malformed inventory,
missing D-002 rows and server-only WASM in web output. Temporary violation probes were removed.

## Scope

These are scaffold checks, not Phase 1 acceptance tests. Application packages remain empty.
The browser test uses a static page to verify Playwright itself. Docker services and image
pins arrive in T07; the API and web app arrive in T10/T12. Schema export is pending T02 and
performance testing is pending T20. CI enables those stages when their artifacts are added.

The documented defaults were retained, including Drizzle and React; no default was promoted
to an accepted decision. Runtime dependencies are deferred to their owning tasks, so T01
installs no QuickJS or browser WASM. GitHub Actions was configured but has not run remotely.
