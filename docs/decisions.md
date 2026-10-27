# Decisions

The decision log. Each entry has a status:

| Status         | Meaning                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Accepted**   | Build on it. Changing it needs a new entry that supersedes it, approved by a human.                                                        |
| **Default**    | Use it now. It is a sensible starting choice with real alternatives; revisit at the stated decision point, with evidence.                  |
| **Open**       | Not decided. Evaluate the listed options before the stated point. Until then, keep the code behind an interface so the choice stays cheap. |
| **Superseded** | Replaced by a later entry. Kept for history.                                                                                               |

The per-library view of the same choices, with alternatives, is in [tech-stack.md](tech-stack.md). Decision points by stage are at the [end of this file](#decision-points-by-stage).

## D-001 TypeScript end to end

**Status:** Accepted

**Decision:** All code we write is TypeScript (strict), running on Node on the server and evergreen browsers on the client.

**Why:** The same rules code must run in the browser, the rules host, the CLI and tests. One language keeps the contracts in one type system.

## D-002 WebAssembly where it is the best tool

**Status:** Accepted (supersedes the earlier "No WebAssembly" entry)

**Decision:**

1. **Our own code is TypeScript.** We do not write Rust, C or C++ modules compiled to WebAssembly ourselves unless profiling shows a hot path that TypeScript cannot handle, and a decision entry records it.
2. **WASM-backed libraries are welcome where they are clearly the best option** on measurable grounds: performance, correctness, isolation, or a much better maintained ecosystem than the JavaScript alternative.
3. **Every WASM module in the product is listed** in the inventory below and in `wasm-inventory.json`, with its reason and its fallback. CI checks the list (CI-WASM-INVENTORY in [testing.md](testing.md)).
4. **WASM is loaded lazily** (only on the pages or processes that need it), **self-hosted** (no runtime fetches from third-party CDNs), served as `application/wasm` so browsers can compile while downloading, and wrapped behind our own interface (`PhysicsAdapter`, `RulesSandbox`, `TextureLoader`…) so it can be swapped.

**Why WASM needs a reason, not a ban.** WASM is the right tool for code that is compute-heavy, already written in another language, or needs its own isolated memory. Its costs are real but manageable:

| Cost                      | What it means for us                                                                       | How we manage it                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Download and compile time | Modules are often 0.5–2 MB and must compile before first use                               | Lazy loading, streaming compilation, caching                               |
| Debugging                 | Stack traces and stepping stop at the boundary; bugs inside need the library's maintainers | Use only maintained libraries; keep our logic on the TypeScript side       |
| Memory                    | Linear memory is not garbage-collected; some bindings need manual `dispose()`              | Wrap in our interfaces, which own the lifetimes; leak tests                |
| Supply chain              | Binaries are harder to review than JavaScript                                              | Pin versions, prefer projects with reproducible builds, record each module |
| Boundary overhead         | Copying data across the JS–WASM boundary costs time                                        | Design APIs with few, coarse calls (whole moves, whole physics steps)      |

**WASM inventory**

| Use                                                        | Library                                                                               | Phase       | Why WASM is the better choice here                                                                                                                                           | Fallback or alternative kept open                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Sandbox for untrusted game code on the server              | quickjs-emscripten-core + @jitl/quickjs-wasmfile-release-sync (QuickJS interpreter)   | 1           | A separate interpreter with its own heap gives a real isolation boundary, with built-in memory and CPU limits. Node's `vm` module is documented as not a security mechanism. | Node process + `vm` + permission flags; isolated-vm; Deno subprocess; containers (D-008) |
| Physics                                                    | Rapier (`@dimforge/rapier3d`; `@dimforge/rapier3d-deterministic` for dexterity games) | 2           | Fast, actively maintained, and offers a cross-platform deterministic build                                                                                                   | cannon-es (pure JavaScript); Jolt (also WASM)                                            |
| GPU-compressed textures                                    | Basis Universal transcoder via Three.js `KTX2Loader`                                  | 2           | Textures stay compressed in GPU memory: several times less memory and faster uploads, which matters on phones with many cards on the table                                   | PNG, WebP or AVIF only                                                                   |
| Geometry decoding                                          | meshoptimizer decoder (`EXT_meshopt_compression`)                                     | 2           | Small, fast decoder; much smaller model downloads                                                                                                                            | Draco; plain glTF with quantization                                                      |
| Mesh simplification for LODs (asset pipeline, server side) | meshoptimizer via glTF Transform                                                      | 2           | The standard simplifier; nothing comparable in pure JavaScript                                                                                                               | Author-supplied LODs                                                                     |
| Local inference for bots                                   | ONNX Runtime Web (WebGPU execution provider)                                          | 3           | Runs learned models on the designer's own GPU                                                                                                                                | Server-side inference                                                                    |
| Local analytics                                            | DuckDB-WASM                                                                           | 3, optional | SQL over local simulation results, offline                                                                                                                                   | Server-side analytics only                                                               |
| Local project storage                                      | SQLite (official WASM build) over OPFS                                                | Open        | Real queries over large local datasets                                                                                                                                       | IndexedDB (current default, D-015)                                                       |

**Where we deliberately do not use WASM:** the rules runtime `@bgp/rules` (must stay small, auditable and identical everywhere), hashing (Web Crypto and Node `crypto` already exist), card generation (Canvas 2D is enough), and the CLI's bundler (esbuild ships native binaries).

## D-003 Own rules runtime

**Status:** Accepted

**Decision:** Build a small rules runtime in `@bgp/rules`. Borrow ideas from boardgame.io (phases, turns, moves, player views) but do not depend on it.

**Why:** We need hooks it does not provide in the shape we want: sandbox mode, manual operations, integer-only state, state hashing, running inside a sandbox, and later partial enforcement and simulation.

## D-004 Room server

**Status:** Default — revisit in Phase 4 (scaling)

**Decision:** The room server is our own code on `ws` (through `@fastify/websocket`), in the same Node process as the API for Phase 1.

**Why:** Our needs in Phase 1 are small (rooms, seats, ordering, persistence, presence), and our state model (per-seat views, JSON Patch) would duplicate the state sync of frameworks such as Colyseus.

**Alternatives to evaluate later:** Colyseus (rooms and matchmaking only), hosted room primitives such as Cloudflare Durable Objects or PartyKit, uWebSockets.js for connection density.

## D-005 Server-authoritative, no client prediction in Phase 1

**Status:** Accepted

**Decision:** The server decides every state change in remote matches. Clients render views and send intents. No optimistic prediction for enforced games in Phase 1.

**Why:** A client holds only its seat's view, so it cannot correctly run moves that depend on hidden state. Turn-based play tolerates a round trip.

## D-006 Determinism rules

**Status:** Accepted

**Decision:**

- Authoritative state contains only JSON values with integers (no floats), strings, booleans, arrays, objects and `null`.
- Randomness comes from a seeded 32-bit integer PRNG (sfc32) implemented in `@bgp/rules` using only integer operations (`Math.imul`, bit shifts). Its state is part of the match state, never part of game state visible to views.
- Shuffles use Fisher–Yates with unbiased integer sampling (rejection), never `sort` with a random comparator.
- The **state hash** is SHA-256 of the canonical JSON of the match state (object keys sorted, no whitespace).

**Why:** Replays, crash recovery, golden tests and later simulation depend on bit-exact repeatability. Game code runs in several JavaScript engines: QuickJS on the server (D-008), and V8, SpiderMonkey or JavaScriptCore in browsers for hot-seat play and replays. Integer-only math and our own PRNG keep all of them identical; engine-specific floating-point functions do not enter state.

## D-007 Game code in the browser runs only in a Web Worker

**Status:** Accepted

**Decision:**

- Game bundles are evaluated only inside a dedicated Web Worker, never on the main thread.
- Before loading game code, the worker removes or replaces network and storage globals (`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts`, `indexedDB`, `caches`, `BroadcastChannel`).
- API authentication uses bearer tokens held in main-thread memory (OIDC with PKCE). No authentication cookies.

**Why:** Game code is untrusted. Same-origin workers send cookies with requests, so cookie auth would let a game call the API as the player. Bearer tokens kept on the main thread are out of the worker's reach. In the browser, game code only ever sees that seat's view, so a worker is a proportionate boundary; running QuickJS in the browser too stays possible if that changes.

## D-008 Server-side isolation of game code

**Status:** Default — confirmed or changed by the T08 spike

**Decision (Phase 1 default):**

- Game code runs only in the **rules host**: separate Node processes spawned by the server.
- Inside a rules host, each match runs in its own **QuickJS runtime** (quickjs-emscripten, synchronous release build). The `@bgp/rules` runtime bundle and the game bundle are evaluated **together inside** that runtime, so match state never crosses the boundary on each call. The host sends intents in and receives results and per-seat views out, as JSON.
- Limits per runtime: memory cap (default 64 MB) and an interrupt handler that stops any call after 1000 ms.
- No host functions are exposed to game code except the ones the runtime needs (none touch I/O).
- As a second layer, rules host processes start with Node's permission model (`--permission` with reads limited to their own code and the bundle cache, no writes, no child processes). Check flags against the Node LTS in use.
- A runtime or process that crashes or exceeds limits is discarded; affected matches are rebuilt from snapshot and log.

**Why this default:** A separate interpreter with its own heap is a genuine isolation boundary, which Node's `vm` module is not. QuickJS gives memory and time limits out of the box, runs anywhere, and its slower speed (an interpreter, not a JIT) does not matter for turn-based moves that take milliseconds. Caveat: quickjs-emscripten states it has not been audited, so it is one layer, not the only one.

**Alternatives kept open:**

| Option                                                      | Strength                          | Weakness                                                                                   |
| ----------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------ |
| Node process + worker threads + `vm` + permission flags     | Fastest (V8 JIT), simplest        | `vm` is not a security boundary; acceptable only for private, invite-only play             |
| isolated-vm                                                 | V8 isolates, fast, memory limits  | In maintenance mode; native addon; its README advises keeping it out of critical processes |
| Deno subprocess with all permissions denied                 | Strong permission model, V8 speed | Second runtime to operate; per-process overhead                                            |
| Containers or microVMs per rules host (gVisor, Firecracker) | Strongest outer boundary          | Operational weight; an outer layer, combined with one of the above                         |

**Spike criteria for T08:** Harbor Market move p95 under 20 ms inside QuickJS; new match load under 300 ms; memory per idle match under 16 MB; all INT-ISOLATION cases contained. If QuickJS misses, fall back to the first alternative and keep Phase 1 games private or unlisted.

**Phase 4 gate:** before public listing, add an outer layer (containers or microVMs) and an external security review (Q-003).

## D-009 Client frameworks and rendering

**Status:** Three.js for 3D: Accepted. React: Default, confirm before T12. PixiJS for 2D: Default, spike at T13.

**Decision:** React with Vite for the app shell. PixiJS v8 for the 2D table in Phase 1. Three.js `WebGPURenderer` with automatic WebGL2 fallback for the 3D table in Phase 2, with materials written as TSL node materials. Renderers implement the `TableRenderer` interface.

**Why:** React is familiar to most contributors and agents. PixiJS gives a fast 2D canvas on WebGPU or WebGL. One renderer interface lets 2D and 3D share everything else.

**Alternatives worth a look:** Svelte or SolidJS for the shell (decide once, before T12; switching later is expensive). For 2D: a top-down orthographic Three.js view (one engine for 2D and 3D) or plain Canvas 2D (no dependency).

**T13 evidence:** [renderer comparison](spikes/t13-renderer-2d.md). The PixiJS adapter
is implemented behind `TableRenderer`, with 8.6.6 pinned because inspected newer
v8 distributions ship optional WASM transcoders that violate AC-14. The choice
remains Default pending physical-phone performance evidence and human confirmation.

## D-010 Repository tooling

**Status:** pnpm, Vitest, Playwright: Accepted. Turborepo, Biome, esbuild: Default.

**Decision:** pnpm workspaces with Turborepo, Biome for lint and format, Vitest and fast-check for tests, Playwright for end-to-end tests, esbuild for game bundles.

**Alternatives:** Nx or plain `pnpm -r` instead of Turborepo; ESLint with Prettier, or dependency-cruiser for boundary checks, if Biome's rules fall short; Rolldown for bundling.

## D-011 Data storage

**Status:** PostgreSQL and the event-log model: Accepted. Drizzle: Default.

**Decision:** PostgreSQL as the system of record, accessed with Drizzle ORM and migrated with drizzle-kit. Matches are an append-only event log plus periodic snapshots. No Redis or analytics store in Phase 1.

**Alternatives:** Kysely or Prisma instead of Drizzle (decide at T07; low stakes).

## D-012 Contracts as Zod schemas

**Status:** Default

**Decision:** Every contract in `docs/contracts/` is implemented as Zod schemas in `@bgp/schema`, with TypeScript types inferred from them and JSON Schema generated for external tools.

**Alternatives:** Valibot (smaller bundles) or TypeBox (JSON Schema first), if bundle size inside games or schema export becomes a problem.

## D-013 Accounts and guests

**Status:** OIDC and guest invites: Accepted. Identity provider: Open.

**Decision:** Designers sign in with OIDC. Keycloak runs locally for development. Playtesters join by invite link as **guests**: the server issues a signed, match-scoped guest token. Guests cannot create games.

**Open:** the production identity provider (Keycloak, Zitadel, Authentik, a university SSO, or a hosted service), decided together with hosting (Q-002).

## D-014 Object storage behind an interface

**Status:** Interface: Accepted. Production provider: Open (Q-002).

**Decision:** A `BlobStore` interface with a local filesystem driver (development, tests) and an S3-compatible driver (production). Keys are content-addressed by SHA-256.

## D-015 Local-first projects without live sync

**Status:** Default

**Decision:** Projects live in IndexedDB. Publishing is an explicit upload that creates an immutable game version. No background sync in Phase 1.

**Alternatives later:** SQLite WASM over OPFS when local data grows (simulation results in Phase 3); a CRDT library (Yjs, Automerge) if multi-device or co-editing becomes a need.

---

## Decision points by stage

What to decide, when, and how to judge it. Record each outcome as a new entry or a status change above.

| When                    | Decide                                               | Options                                                                   | Judge by                                                                                             |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Before T07              | ORM                                                  | Drizzle, Kysely, Prisma                                                   | Migration workflow, typed queries, team familiarity                                                  |
| T08 spike               | Server sandbox (D-008)                               | QuickJS, `vm` + process, isolated-vm, Deno                                | Spike criteria in D-008                                                                              |
| Before T12              | App shell framework (D-009)                          | React, Svelte, SolidJS                                                    | Team familiarity, ecosystem for editors, agent reliability                                           |
| T13 spike               | 2D renderer (D-009)                                  | PixiJS, Three.js orthographic, Canvas 2D                                  | 300 draggable items at 60 fps on a mid-range phone; crisp text; reuse in Phase 2                     |
| Before first deployment | Hosting, storage provider, identity provider (Q-002) | University infrastructure, cloud providers                                | Cost, data location rules, SSO, operations effort                                                    |
| Phase 2 spike           | Physics                                              | Rapier, cannon-es, Jolt                                                   | 200 bodies at 60 fps on a mid-range phone; believable dice; deterministic replay for dexterity shots |
| Phase 2                 | Texture and model formats                            | KTX2 + Meshopt, WebP/AVIF + plain glTF                                    | GPU memory and load time on the device matrix                                                        |
| Phase 2                 | Job queue                                            | pg-boss (PostgreSQL only), BullMQ (Redis)                                 | Whether Redis is otherwise needed                                                                    |
| Phase 2                 | 3D text                                              | MSDF text library, baked canvas textures                                  | Crispness at close-up; `WebGPURenderer` support                                                      |
| Phase 3                 | Analytics store                                      | PostgreSQL views, DuckDB (native or WASM), ClickHouse                     | Query speed on simulation volumes                                                                    |
| Phase 3                 | Bot inference location                               | ONNX Runtime Web, server-side                                             | Model size, latency, privacy of unpublished designs                                                  |
| Phase 4                 | Scaling rooms and presence                           | Redis or Valkey pub/sub, PostgreSQL LISTEN/NOTIFY, hosted room primitives | Connection counts, operations effort                                                                 |
| Phase 4                 | Isolation hardening (Q-003)                          | Containers, microVMs, plus review                                         | External security review                                                                             |

## Open questions

Agents: add questions here with the option you chose for now and why.

| ID    | Question                                                                                                        | Current default                                                                                                                                                                                                                         | Needed by                           |
| ----- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Q-001 | Platform name and package scope                                                                                 | `@bgp/*`, CLI `bgp`                                                                                                                                                                                                                     | Before public release               |
| Q-002 | Hosting: university infrastructure or a cloud provider; with it, the storage and identity providers             | Container images, no provider-specific services                                                                                                                                                                                         | Before first deployment             |
| Q-003 | Outer isolation layer and security review for public games                                                      | QuickJS in separate processes (D-008)                                                                                                                                                                                                   | Phase 4                             |
| Q-004 | Dexterity physics: deterministic Rapier on every client, or simulate on the server and play back the trajectory | Not started                                                                                                                                                                                                                             | Phase 2 spike                       |
| Q-005 | Confirm the minimal public HTTP response envelopes and validation-error shape added in T02                      | Use the shapes in contracts/http-api.md; expose no database internals or match seed                                                                                                                                                     | T10 API implementation              |
| Q-006 | Die face strings represent either labels or assets; how should extension-like labels be escaped?                | Treat image extensions as asset references and reject SVG paths; other strings are labels                                                                                                                                               | T16 authoring UI                    |
| Q-007 | How should repeated event calls and events emitted by hooks compose?                                            | T03 uses last call per kind in ordered batches; hook events run in the next batch, with a 128-call transaction limit. This bounds accidental cascades and preserves the documented phase/active/turn/result ordering; see rules-api.md. | Revisit with T04/T06 game authoring |
| Q-008 | Confirm the T13 renderer choice after physical-phone profiling and the headless Chromium cadence investigation  | Keep the WASM-free PixiJS v8 adapter behind TableRenderer; compare Canvas on hardware                                                                                                                                                   | T13 confirmation                    |
