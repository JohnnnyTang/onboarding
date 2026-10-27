# T02 validation

Validated locally on 2026-10-27 on Windows with Node 24.12.0 and pnpm 11.9.0.

## Delivered

- `@bgp/schema` now implements all five contract documents with Zod 4.6.7 validators,
  inferred data types and generic SDK interfaces. It imports no platform or renderer APIs.
- Rules data includes integer-only JSON, context, state, RNG words, views, results,
  intents, events and action buttons. Callable shapes are checked without executing them.
- All component kinds, zones, sandbox setup/state, gestures, manual operations and table
  snapshots have validators. Contextual snapshot validators reject identifiable hidden
  items for other seats and spectators, while allowing a seat to know its own hand.
- Manifests validate both modes, semantic versions, player ranges, paths, options and
  sandbox requirements. HTTP schemas cover all 18 endpoints; protocol schemas cover all
  client/server messages, RFC 6902 operations and documented error codes.
- `pnpm json-schema` exports 109 committed Draft 2020-12 documents. CI runs generation
  unconditionally and checks for changed, missing or new files. Tests check all local
  `$ref` targets and compare committed documents with the current definitions.
- All 12 JSON examples in the contract documents are parsed directly from Markdown in
  tests. The protocol error-code table and HTTP endpoint table are also checked for drift.
- Zod is pinned exactly in the package and lockfile and recorded in tech-stack.md. No
  other runtime dependency or WASM module was added.

## Checks

| Check                            | Result                                                                   |
| -------------------------------- | ------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile` | Pass                                                                     |
| `pnpm json-schema`               | Pass: 109 files                                                          |
| `pnpm lint`                      | Pass, including package boundaries                                       |
| `pnpm typecheck`                 | Pass across the workspace and tooling                                    |
| `pnpm test`                      | Pass: 133 schema tests, 9 other package tests, 43 tooling/contract tests |
| `pnpm build`                     | Pass: all 10 packages                                                    |
| `pnpm check:wasm`                | Pass: 0 modules                                                          |

Rejection tests cover malformed slugs, versions, paths and option defaults; floats,
unsafe/nonfinite numbers, undefined, cycles and non-JSON objects; unknown messages and
fields; SVG images (including die faces); bad references, coordinates and rotations;
and `def` on items the viewing seat cannot identify. Integer JSON validation preserves
arbitrary keys such as `__proto__` unchanged, without mutating object prototypes.

## Scope and open choices

Generated JSON Schemas describe serializable structure. Cross-field and contextual
checks still use the Zod validators. The integer-JSON custom validator has a precise
recursive export; other unsupported validators cause export to fail. Functions are
excluded from JSON export, with TypeScript interfaces and shallow callable validators.
The renderer container is generic so browser callers can use `TableRenderer<HTMLElement>`
without adding a DOM dependency to the pure package.

Structural schemas cannot establish ID provenance, infer hidden game information,
enforce room ordering, validate uploaded file bytes or prove game purity. Those checks
remain with their documented runtime, testing, isolation and server tasks. T02 adds no
rules runtime, API implementation or renderer and makes no remote CI claim.

The contracts now specify minimal HTTP response envelopes and the convention for die
face strings. These reversible defaults are recorded as Q-005 and Q-006 in decisions.md
for confirmation during the API and authoring tasks. No manifest or protocol version
was bumped: the response shapes were previously unspecified and existing shapes remain
compatible.
