# Contracts

Source-of-truth interfaces. Code in `@bgp/schema` implements them; change both together (AGENTS.md rule 4).

Import validators as `ManifestSchema`, `ClientMessageSchema`, etc. and the matching inferred
types without the `Schema` suffix. Data objects reject unknown fields; HTTP headers permit
unrelated headers. Parsing does not coerce values or fill defaults. HTTP adapters decode
query strings before validating `ListQuerySchema` and apply the default limit of 50.

Run `pnpm json-schema` to regenerate the committed Draft 2020-12 files in
`packages/schema/json/`. CI regenerates them and checks for drift. The exports describe
serializable structure; cross-field checks (references, option ranges/defaults, sandbox
requirements and seat visibility) still require the Zod validators. Callable contracts
(`GameDefinition`, `Random`, hooks and events) have TypeScript interfaces and shallow Zod
shape validators; they are not JSON and are excluded from export. Shape validation never
executes game code or establishes its purity: execution stays in the T08 sandbox.

The JSON blocks in these contracts are executable fixtures, checked directly by
`scripts/contract-examples.test.ts`. The preceding `schema` comment names their validator.

| File                                               | Defines                                                                                                                     | Version field                           |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| [rules-api.md](rules-api.md)                       | `GameDefinition`, moves, ctx, randomness, runtime API, order of operations                                                  | `sdk: 1`                                |
| [components-and-table.md](components-and-table.md) | Component declarations, zones, coordinates, `TableSnapshot`, gestures, `TableRenderer`, sandbox state and manual operations | `schemaVersion: 1` in `components.json` |
| [manifest.md](manifest.md)                         | `bgp.json`, version limits, upload flow, build hash                                                                         | `schemaVersion: 1`                      |
| [protocol.md](protocol.md)                         | WebSocket messages, ordering, rate limits, error codes                                                                      | `PROTOCOL_VERSION = 1`                  |
| [http-api.md](http-api.md)                         | REST endpoints, authentication, error body                                                                                  | —                                       |
