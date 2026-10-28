# T08 initial spike validation

The initial fixture comparison is ready for review on `codex/t08-rules-host`.
T08 remains in progress. See the [spike report](spikes/t08-sandbox.md) for measurements,
recommendation and remaining production/Harbor Market requirements.

Validated locally on 2026-10-27 with Node v24.12.0 and pnpm 11.9.0:

- `pnpm build` passes for all ten workspace packages/apps.
- `pnpm typecheck` and `pnpm lint` pass across the workspace.
- `pnpm test` passes: 270 package/app tests and 46 root tooling tests, including
  database integration tests. Of these, 26 package tests and one root cross-engine
  determinism test exercise the new T08 prototypes.
- `pnpm check:wasm` passes with exactly one 503,134-byte synchronous release binary
  in the production dependency tree and none in web output.
- `pnpm exec tsx scripts/t08-sandbox.ts` records 500 matching Node hashes for each
  option, 20 warm-load samples per option and nine contained hostile cases per option.

No wire protocol or game contract changed. No renderer, game, database or
authentication implementation changed. The public package is still a sandbox
prototype: it must not yet be wired into a server as the production isolation host.

The first workspace test run exposed a too-short 100 ms test load deadline under
concurrent workspace activity; isolation tests now use the documented 1000 ms
default. The first inventory run also caught that `**` does not traverse `.pnpm`;
the inventory now uses the exact pinned binary path. Both checks pass after those fixes.

Not claimed: Harbor Market performance, production host IPC/crash recovery,
room-server isolation, AC-09/AC-10 completion or human acceptance of D-008.
