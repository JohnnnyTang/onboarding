import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { applyViewPatch } from "../../apps/web/src/match/view-patch.js";
import manifest from "../../games/harbor-market/bgp.json" with { type: "json" };
import declarations from "../../games/harbor-market/components.json" with { type: "json" };
import {
  ClaimInviteResponseSchema,
  type ClientView,
  ComponentsFileSchema,
  CreateMatchResponseSchema,
  componentAssetRefs,
  FinalizeResponseSchema,
  GameResponseSchema,
  type MoveIntent,
  PROTOCOL_VERSION,
  type ServerMessage,
  ServerMessageSchema,
  VersionResponseSchema,
} from "../../packages/schema/src/index.js";
import { perfDatabaseUrl, prepareDatabase } from "../e2e-database.js";
import { type LatencySummary, summarize } from "./latency.js";

// PERF-01 (docs/testing.md, AC-11): 20 concurrent Harbor Market matches on one server, played
// by scripted clients over the room server's WebSocket protocol. Each move's round trip is
// the time from sending `move` to receiving the mover's own `patch`. Fails if p95 >= 200 ms.
//
// The script starts its own API and room server (apps/server, the rules host in QuickJS) on
// loopback against a `bgp_perf` database, with a local token issuer in place of Keycloak, so
// it needs only PostgreSQL and a prior `pnpm build`.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const LIMIT_P95_MS = 200;
/** The room accepts at most 10 moves per second per connection (protocol.md). */
const MIN_MOVE_INTERVAL_MS = 110;
const WAIT_MS = 15_000;

const { values: flags } = parseArgs({
  options: {
    matches: { type: "string", default: "20" },
    seats: { type: "string", default: "4" },
    moves: { type: "string", default: "150" },
    "think-ms": { type: "string", default: "250" },
    out: { type: "string" },
  },
});

function positive(name: string, raw: string | undefined, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`--${name} must be an integer from 0 to ${max}`);
  }
  return value;
}

const settings = {
  matches: positive("matches", flags.matches, 200),
  seats: positive("seats", flags.seats, manifest.players.max),
  /** Swaps each match plays before playing to the end. */
  moves: positive("moves", flags.moves, 5000),
  /** Pause between one move's patch and the next move in the same match. */
  thinkMs: positive("think-ms", flags["think-ms"], 60_000),
};
if (settings.seats < manifest.players.min) throw new Error("Too few seats for Harbor Market");

// ---------------------------------------------------------------------------------------------
// A local OIDC issuer: a JWKS endpoint and RS256 access tokens for one designer.

interface Issuer {
  url: string;
  token(): string;
  close(): Promise<void>;
}

async function startIssuer(): Promise<Issuer> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "perf", alg: "RS256", use: "sig" };
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await listen(server, 0);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    token: () => signToken(privateKey, url),
    close: () => new Promise((done) => server.close(() => done())),
  };
}

function signToken(key: KeyObject, issuer: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "RS256", kid: "perf", typ: "JWT" });
  const payload = encode({
    iss: issuer,
    aud: "bgp-api",
    sub: "perf-designer",
    name: "PERF-01 designer",
    iat: now,
    exp: now + 3600,
  });
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => done());
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await listen(server, 0);
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return port;
}

// ---------------------------------------------------------------------------------------------
// The server under test, as a separate process like in production.

async function startServer(issuer: Issuer, databaseUrl: string, blobDir: string) {
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "apps/server/src/main.ts"], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_WEB_ORIGIN: "http://localhost:5173",
      OIDC_ISSUER: issuer.url,
      OIDC_AUDIENCE: "bgp-api",
      OIDC_JWKS_URL: `${issuer.url}/jwks`,
      GUEST_TOKEN_SECRET: randomBytes(32).toString("base64"),
      BLOB_DRIVER: "fs",
      BLOB_FS_DIR: blobDir,
      LOG_LEVEL: "warn",
    },
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error("The server exited during start-up");
    try {
      const response = await fetch(`${url}/api/healthz`);
      if (response.ok) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error("The server did not start within 60 s");
    await delay(250);
  }
  return { url, child };
}

function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((done) => {
    child.once("exit", () => done());
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5000).unref();
  });
}

// ---------------------------------------------------------------------------------------------
// Fixtures through the HTTP API, as a designer would create them.

/** Calls the API; `token` null calls it signed out, as a guest claiming an invite. */
async function api(
  base: string,
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
  return text === "" ? undefined : (JSON.parse(text) as unknown);
}

/** The Harbor Market bundle, built the way `bgp build` does. */
async function harborFiles(): Promise<Record<string, Buffer>> {
  const built = await build({
    entryPoints: [join(ROOT, "games/harbor-market/src/index.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    write: false,
  });
  const output = built.outputFiles[0];
  if (!output) throw new Error("Harbor Market bundle missing");
  const components = ComponentsFileSchema.parse(declarations);
  const files: Record<string, Buffer> = {
    "components.json": Buffer.from(JSON.stringify(components)),
    [manifest.entry]: Buffer.from(output.contents),
  };
  for (const ref of componentAssetRefs(components)) {
    files[ref] = await readFile(join(ROOT, "games/harbor-market", ref));
  }
  return files;
}

async function publishHarbor(base: string, token: string): Promise<string> {
  const slug = `perf-${randomBytes(6).toString("hex")}`;
  const game = GameResponseSchema.parse(
    await api(base, token, "POST", "/api/games", {
      slug,
      name: "Harbor Market",
      visibility: "unlisted",
    }),
  );
  const version = VersionResponseSchema.parse(
    await api(base, token, "POST", `/api/games/${game.id}/versions`, { ...manifest, id: slug }),
  );
  for (const [path, bytes] of Object.entries(await harborFiles())) {
    const response = await fetch(`${base}/api/versions/${version.id}/files/${path}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/octet-stream",
        "x-content-sha256": createHash("sha256").update(bytes).digest("hex"),
      },
      body: new Uint8Array(bytes),
    });
    if (response.status !== 204) throw new Error(`upload ${path}: ${await response.text()}`);
  }
  // A failed finalize is an HTTP error; success returns the build hash.
  FinalizeResponseSchema.parse(
    await api(base, token, "POST", `/api/versions/${version.id}/finalize`, {}),
  );
  return version.id;
}

/** Creates a started match and returns each seat's guest token. */
async function createMatch(base: string, token: string, versionId: string) {
  const created = CreateMatchResponseSchema.parse(
    await api(base, token, "POST", "/api/matches", {
      versionId,
      seatCount: settings.seats,
      options: { shortGame: false },
    }),
  );
  const guests: { seat: string; token: string }[] = [];
  for (const invite of created.invites) {
    const inviteToken = new URL(invite.url).pathname.split("/").at(-1) ?? "";
    const claimed = ClaimInviteResponseSchema.parse(
      await api(base, null, "POST", `/api/invites/${inviteToken}/claim`, {
        displayName: `Bot ${Number(invite.seat) + 1}`,
      }),
    );
    if (!claimed.guestToken) throw new Error("Missing guest token");
    guests.push({ seat: claimed.seat, token: claimed.guestToken });
  }
  await api(base, token, "POST", `/api/matches/${created.match.id}/start`, {});
  return { matchId: created.match.id, guests };
}

// ---------------------------------------------------------------------------------------------
// A scripted client: keeps its view current by applying patches, as the web app does.

class PerfSeat {
  seq = 0;
  view: ClientView | null = null;
  lastMoveAt = 0;
  private clientSeq = 0;
  private pending: { clientSeq: number; sentAt: number; done: (ms: number) => void } | null = null;
  private readonly waiters = new Set<() => void>();
  private failure: string | null = null;
  resyncs = 0;

  private constructor(
    private readonly socket: WebSocket,
    readonly seat: string,
  ) {
    socket.onmessage = (event) => {
      const parsed = ServerMessageSchema.safeParse(JSON.parse(String(event.data)));
      if (!parsed.success) this.failure = "Invalid server message";
      else this.receive(parsed.data);
      for (const wake of this.waiters) wake();
    };
    socket.onclose = () => {
      this.failure ??= "Connection closed";
      for (const wake of this.waiters) wake();
    };
  }

  static async connect(url: string, matchId: string, seat: string, token: string) {
    const socket = new WebSocket(url);
    await new Promise<void>((done, fail) => {
      socket.onopen = () => done();
      socket.onerror = () => fail(new Error("WebSocket failed"));
    });
    const client = new PerfSeat(socket, seat);
    client.send({
      t: "hello",
      protocol: PROTOCOL_VERSION,
      matchId,
      auth: { kind: "guest", token },
    });
    await client.until(() => client.view !== null);
    return client;
  }

  private receive(message: ServerMessage) {
    switch (message.t) {
      case "welcome":
      case "snapshot":
        this.view = message.view;
        this.seq = message.seq;
        break;
      case "patch": {
        const next =
          this.view && message.seq === this.seq + 1 ? applyViewPatch(this.view, message.ops) : null;
        this.seq = message.seq;
        this.view = next;
        if (!next) {
          this.resyncs += 1;
          this.send({ t: "resync" });
        }
        const pending = this.pending;
        if (pending && message.cause.clientSeq === pending.clientSeq) {
          this.pending = null;
          pending.done(performance.now() - pending.sentAt);
        }
        break;
      }
      case "rejected":
        this.failure = `Move rejected: ${message.code} ${message.message}`;
        break;
      case "error":
        this.failure = `${message.code}: ${message.message}`;
        break;
      default:
        break;
    }
  }

  private send(message: unknown) {
    this.socket.send(JSON.stringify(message));
  }

  until(test: () => boolean): Promise<void> {
    return new Promise((done, fail) => {
      const timer = setTimeout(() => finish(new Error(`Seat ${this.seat} timed out`)), WAIT_MS);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        if (error) fail(error);
        else done();
      };
      const check = () => {
        if (this.failure) finish(new Error(this.failure));
        else if (test()) finish();
      };
      this.waiters.add(check);
      check();
    });
  }

  /** Sends a move and resolves with its round trip once the mover's own patch arrives. */
  async move(intent: MoveIntent): Promise<number> {
    let roundTrip = Number.NaN;
    const clientSeq = this.clientSeq++;
    this.lastMoveAt = performance.now();
    this.pending = {
      clientSeq,
      sentAt: this.lastMoveAt,
      done: (ms) => {
        roundTrip = ms;
      },
    };
    this.send({ t: "move", clientSeq, intent });
    await this.until(() => !Number.isNaN(roundTrip));
    return roundTrip;
  }

  close(): void {
    this.socket.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Harbor Market play, deciding from the seat's own view only.

type Card = { id: string; good: string };
type HarborView = { hand: Card[]; deckCount: number; market: Card[] };

function botMove(view: ClientView, swap: boolean): MoveIntent {
  const game = view.game as HarborView;
  const [hand] = game.hand;
  const [market] = game.market;
  if (view.ctx.phase === "discard") {
    const cards = game.hand.slice(0, game.hand.length - 6).map((card) => card.id);
    return { move: "discard", args: { cards } };
  }
  if (swap && hand && market) return { move: "swap", args: { hand: hand.id, market: market.id } };
  const goods = new Map<string, string[]>();
  for (const card of game.hand) goods.set(card.good, [...(goods.get(card.good) ?? []), card.id]);
  const set = [...goods.values()].find((ids) => ids.length >= 2);
  if (set) return { move: "ship", args: { cards: set } };
  if (game.deckCount > 0) return { move: "restock" };
  if (hand && market) return { move: "swap", args: { hand: hand.id, market: market.id } };
  return { move: "pass" };
}

interface MatchRun {
  samples: number[];
  resyncs: number;
}

async function playMatch(seats: PerfSeat[]): Promise<MatchRun> {
  const samples: number[] = [];
  const [watcher] = seats;
  if (!watcher) throw new Error("No seats");
  let seq = watcher.seq;
  for (;;) {
    await Promise.all(seats.map((seat) => seat.until(() => seat.seq >= seq && seat.view !== null)));
    const view = watcher.view;
    if (!view) throw new Error("No view");
    if (view.result !== null) break;
    if (seq > settings.moves + 400) throw new Error("Harbor Market did not finish");
    const mover = seats.find((seat) => seat.seat === view.ctx.currentSeat);
    if (!mover?.view) throw new Error("No seat to move");
    const rateWait = mover.lastMoveAt + MIN_MOVE_INTERVAL_MS - performance.now();
    await delay(Math.max(settings.thinkMs, rateWait));
    samples.push(await mover.move(botMove(mover.view, seq < settings.moves)));
    seq += 1;
  }
  return {
    samples,
    resyncs: seats.reduce((sum, seat) => sum + seat.resyncs, 0),
  };
}

// ---------------------------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function commit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT }).toString().trim();
  } catch {
    return null;
  }
}

interface Result {
  test: "PERF-01";
  date: string;
  commit: string | null;
  settings: typeof settings;
  environment: Record<string, string | number>;
  durationS: number;
  movesPerSecond: number;
  roundTripMs: LatencySummary;
  perMatchP95Ms: { min: number; max: number };
  resyncs: number;
  limitP95Ms: number;
  pass: boolean;
}

async function main(): Promise<void> {
  const envFile = resolve(ROOT, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  if (!existsSync(join(ROOT, "packages/rules-host/dist"))) {
    throw new Error("Run pnpm build first: the rules host bundle is missing.");
  }
  const databaseUrl = perfDatabaseUrl(process.env);
  await prepareDatabase(databaseUrl);
  const blobDir = await mkdtemp(join(tmpdir(), "bgp-perf-blobs-"));
  const issuer = await startIssuer();
  let server: { url: string; child: ChildProcess } | undefined;
  const seats: PerfSeat[] = [];
  try {
    server = await startServer(issuer, databaseUrl, blobDir);
    const token = issuer.token();
    const versionId = await publishHarbor(server.url, token);
    const wsUrl = `${server.url.replace(/^http/, "ws")}/ws`;
    console.info(
      `PERF-01: ${settings.matches} matches × ${settings.seats} seats, ${settings.moves} swaps each then play to the end, ${settings.thinkMs} ms between moves`,
    );
    const tables: PerfSeat[][] = [];
    for (let index = 0; index < settings.matches; index += 1) {
      const match = await createMatch(server.url, token, versionId);
      const table = await Promise.all(
        match.guests.map((guest) =>
          PerfSeat.connect(wsUrl, match.matchId, guest.seat, guest.token),
        ),
      );
      seats.push(...table);
      tables.push(table);
    }
    const started = performance.now();
    const runs = await Promise.all(tables.map((table) => playMatch(table)));
    const durationS = (performance.now() - started) / 1000;
    const samples = runs.flatMap((run) => run.samples);
    const roundTripMs = summarize(samples);
    const perMatch = runs.map((run) => summarize(run.samples).p95);
    const result: Result = {
      test: "PERF-01",
      date: new Date().toISOString(),
      commit: commit(),
      settings,
      environment: {
        platform: `${platform()} ${release()} ${arch()}`,
        cpu: cpus()[0]?.model.trim() ?? "unknown",
        cores: cpus().length,
        memoryGb: Math.round(totalmem() / 2 ** 30),
        node: process.version,
        // biome-ignore lint/suspicious/noUndeclaredEnvVars: a script, not a turbo task
        sandbox: process.env.RULES_SANDBOX || "quickjs",
        network: "loopback",
      },
      durationS: Math.round(durationS * 10) / 10,
      movesPerSecond: Math.round((samples.length / durationS) * 10) / 10,
      roundTripMs,
      perMatchP95Ms: { min: Math.min(...perMatch), max: Math.max(...perMatch) },
      resyncs: runs.reduce((sum, run) => sum + run.resyncs, 0),
      limitP95Ms: LIMIT_P95_MS,
      pass: roundTripMs.p95 < LIMIT_P95_MS,
    };
    console.info(
      `${roundTripMs.count} moves in ${result.durationS} s (${result.movesPerSecond}/s): ` +
        `p50 ${roundTripMs.p50} ms, p95 ${roundTripMs.p95} ms, p99 ${roundTripMs.p99} ms, max ${roundTripMs.max} ms`,
    );
    if (flags.out) {
      const out = resolve(flags.out);
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
      console.info(`Results written to ${flags.out}`);
    }
    if (!result.pass) {
      console.error(`PERF-01 failed: p95 ${roundTripMs.p95} ms is not under ${LIMIT_P95_MS} ms`);
      process.exitCode = 1;
    } else {
      console.info(`PERF-01 passed: p95 under ${LIMIT_P95_MS} ms`);
    }
  } finally {
    for (const seat of seats) seat.close();
    if (server) await stopServer(server.child);
    await issuer.close();
    await rm(blobDir, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  // Driver errors can contain credentials; print only the message of our own errors.
  console.error(
    `PERF-01 could not run: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
}
