# WASM inventory check

Run `pnpm build` and then `pnpm check:wasm`. The check reads
`pnpm -r list --prod --depth Infinity --json`, traverses its installed production dependency
paths and scans workspace files (including build outputs). Development-only dependency
binaries are excluded. A malformed inventory or failed dependency listing fails the check.

`wasm-inventory.json` starts empty in T01. T08 adds the approved QuickJS module after the spike.
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
