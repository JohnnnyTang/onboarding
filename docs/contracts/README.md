# Contracts

Source-of-truth interfaces. Code in `@bgp/schema` implements them; change both together (AGENTS.md rule 4).

| File                                               | Defines                                                                                                                     | Version field                           |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| [rules-api.md](rules-api.md)                       | `GameDefinition`, moves, ctx, randomness, runtime API, order of operations                                                  | `sdk: 1`                                |
| [components-and-table.md](components-and-table.md) | Component declarations, zones, coordinates, `TableSnapshot`, gestures, `TableRenderer`, sandbox state and manual operations | `schemaVersion: 1` in `components.json` |
| [manifest.md](manifest.md)                         | `bgp.json`, version limits, upload flow, build hash                                                                         | `schemaVersion: 1`                      |
| [protocol.md](protocol.md)                         | WebSocket messages, ordering, rate limits, error codes                                                                      | `PROTOCOL_VERSION = 1`                  |
| [http-api.md](http-api.md)                         | REST endpoints, authentication, error body                                                                                  | —                                       |
