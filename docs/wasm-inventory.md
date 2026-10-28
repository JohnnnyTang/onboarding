# WASM inventory check

Run `pnpm build` and then `pnpm check:wasm`. The check reads
`pnpm -r list --prod --depth Infinity --json`, traverses its installed production dependency
paths and scans workspace files (including build outputs). Development-only dependency
binaries are excluded. A malformed inventory or failed dependency listing fails the check.

`wasm-inventory.json` starts empty in T01. The T08 spike adds the approved synchronous
QuickJS release module (0.32.0, 503,134 bytes), with an explicit pinned `.pnpm` path
because recursive wildcards do not match dot-prefixed store directories.
The modular `quickjs-emscripten-core` + `@jitl/quickjs-wasmfile-release-sync`
distribution installs only that one WASM variant. It is loaded lazily from the local
package in the rules-host process and is never included in web output.
Each module uses this structure:

```json
{
  "id": "quickjs",
  "package": "quickjs-emscripten",
  "decision": "D-002",
  "reason": "Isolates untrusted game code with time and memory limits",
  "fallback": "Restricted Node process; see D-008",
  "scope": "server",
  "files": ["node_modules/**/quickjs*.wasm", "packages/rules-host/dist/**/quickjs*.wasm"]
}
```

The example is illustrative: T08 must record the actual package and binary paths. Patterns
are workspace-relative glob paths. Each package must appear in a D-002 inventory table row;
each discovered `.wasm` must match an entry. The check prints every discovered module's size.
All WASM in `apps/web/dist` fails in Phase 1, including inventoried server-only modules.

The tooling tests plant binaries in isolated fixtures and check unlisted files, transitive
production dependencies, missing D-002 rows and server-only modules in web output.
