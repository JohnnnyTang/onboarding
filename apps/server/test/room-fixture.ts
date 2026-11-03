import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { RulesHostClient, type RulesHostClientOptions } from "@bgp/rules-host";
import {
  ClaimInviteResponseSchema,
  type ClientView,
  CreateMatchResponseSchema,
  type JsonPatchOperation,
  type ServerMessage,
  ServerMessageSchema,
} from "@bgp/schema";
import { eq } from "drizzle-orm";
import jsonpatch from "fast-json-patch";
import type { FastifyInstance, HTTPMethods, LightMyRequestResponse } from "fastify";
import { buildApp } from "../src/app.js";
import { createAuthService } from "../src/auth/service.js";
import { createUserStore } from "../src/auth/user-store.js";
import { type BlobStore, createFsBlobStore } from "../src/blob/blob-store.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/connection.js";
import { matches } from "../src/db/schema.js";
import { RoomManager } from "../src/room/manager.js";
import {
  createRulesSetupChecker,
  createVersionBuildStore,
  type VersionBuildStore,
} from "../src/versions/rules-builds.js";
import { type Package, sha256, WEB_ORIGIN } from "./api-fixture.js";
import { startIssuer, TEST_SECRET } from "./auth-fixture.js";
import { testDatabaseUrl } from "./database.js";

/**
 * Room tests need concurrent connections and real commits, so unlike the HTTP tests they
 * do not run inside a rolled-back transaction. Every fixture uses fresh users, slugs and
 * matches; `match_events` is append-only, so rows stay in the dedicated test database.
 */
export interface RoomEnv {
  connection: DatabaseConnection;
  issuer: Awaited<ReturnType<typeof startIssuer>>;
  blobs: BlobStore;
  builds: VersionBuildStore;
  startServer(options?: ServerOptions): Promise<RoomServer>;
  /** An independent rules host for oracle views and replays (never the server's). */
  mirror(): RulesHostClient;
  close(): Promise<void>;
}

export interface ServerOptions {
  idleMs?: number;
  helloTimeoutMs?: number;
  engine?: RulesHostClientOptions;
}

export interface RoomServer {
  app: FastifyInstance;
  url: string;
  engine: RulesHostClient;
  rooms: RoomManager;
  call(
    method: HTTPMethods,
    url: string,
    options?: { token?: string; body?: unknown },
  ): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

export async function startRoomEnv(): Promise<RoomEnv> {
  const connection = connectDatabase(testDatabaseUrl(), { max: 8 });
  const issuer = await startIssuer();
  const blobDir = await mkdtemp(joinPath(tmpdir(), "bgp-room-blobs-"));
  const blobs = createFsBlobStore(blobDir);
  const builds = createVersionBuildStore(connection.db, blobs);
  const servers = new Set<RoomServer>();
  const mirrors = new Set<RulesHostClient>();
  return {
    connection,
    issuer,
    blobs,
    builds,
    async startServer(options = {}) {
      let rooms: RoomManager | undefined;
      const engine = new RulesHostClient(builds, {
        warmSpareCount: 0,
        ...options.engine,
        onProcessExit: (matchId) => rooms?.hostExited(matchId),
      });
      rooms = new RoomManager({
        db: connection.db,
        engine,
        ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
      });
      const app = await buildApp({
        db: connection.db,
        auth: createAuthService({
          oidc: issuer.oidc,
          guestTokenSecret: TEST_SECRET,
          users: createUserStore(connection.db),
        }),
        blobs,
        setup: createRulesSetupChecker(engine, builds),
        publicWebOrigin: WEB_ORIGIN,
        // ROOM_TEST_LOG=1 prints server-side room errors while debugging a test.
        logger: process.env.ROOM_TEST_LOG ? { level: "error" } : false,
        rooms,
        ...(options.helloTimeoutMs === undefined ? {} : { helloTimeoutMs: options.helloTimeoutMs }),
      });
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const server: RoomServer = {
        app,
        url: `${address.replace(/^http/, "ws")}/ws`,
        engine,
        rooms,
        call(method, url, { token, body } = {}) {
          return app.inject({
            method,
            url,
            headers: token ? { authorization: `Bearer ${token}` } : {},
            ...(body === undefined ? {} : { payload: body as object }),
          });
        },
        async close() {
          if (!servers.delete(server)) return;
          await app.close();
          engine.close();
        },
      };
      servers.add(server);
      return server;
    },
    mirror() {
      const client = new RulesHostClient(builds, { warmSpareCount: 0, idleTimeoutMs: 0 });
      mirrors.add(client);
      return client;
    },
    async close() {
      for (const server of [...servers]) await server.close();
      for (const mirror of mirrors) mirror.close();
      await issuer.close();
      await connection.close();
      await rm(blobDir, { recursive: true, force: true });
    },
  };
}

export const uniqueSlug = (prefix: string) => `${prefix}-${randomBytes(6).toString("hex")}`;

/** A package under a fresh slug, so committed fixtures never collide. */
export function withSlug(pkg: Package, slug: string): Package {
  return { manifest: { ...pkg.manifest, id: slug }, files: pkg.files };
}

export type SeatAuth = { kind: "user" | "guest"; token: string };
export interface ActiveMatch {
  matchId: string;
  versionId: string;
  buildHash: string;
  owner: string;
  seats: SeatAuth[];
  seed: number;
  options: Record<string, never> | { [key: string]: boolean | number | string };
}

async function ok<T>(response: LightMyRequestResponse, status: number) {
  if (response.statusCode !== status)
    throw new Error(`HTTP ${response.statusCode}: ${response.body}`);
  return response.json() as T;
}

/** Publishes `pkg`, creates a match, seats the owner at "0" and guests elsewhere, starts it. */
export async function startMatch(
  env: RoomEnv,
  server: RoomServer,
  pkg: Package,
  seatCount: number,
  options: { start?: boolean } = {},
): Promise<ActiveMatch> {
  const owner = await env.issuer.token({ sub: uniqueSlug("owner"), name: "Owner" });
  const game = await ok<{ id: string }>(
    await server.call("POST", "/api/games", {
      token: owner,
      body: { slug: pkg.manifest.id, name: pkg.manifest.name, visibility: "unlisted" },
    }),
    201,
  );
  const draft = await ok<{ id: string }>(
    await server.call("POST", `/api/games/${game.id}/versions`, {
      token: owner,
      body: pkg.manifest,
    }),
    201,
  );
  for (const [path, bytes] of Object.entries(pkg.files)) {
    const response = await server.app.inject({
      method: "PUT",
      url: `/api/versions/${draft.id}/files/${path}`,
      headers: {
        authorization: `Bearer ${owner}`,
        "x-content-sha256": sha256(bytes),
        "content-type": "application/octet-stream",
      },
      payload: bytes,
    });
    if (response.statusCode !== 204) throw new Error(`upload ${path}: ${response.body}`);
  }
  const version = await ok<{ buildHash: string }>(
    await server.call("POST", `/api/versions/${draft.id}/finalize`, { token: owner, body: {} }),
    200,
  );
  const created = CreateMatchResponseSchema.parse(
    await ok(
      await server.call("POST", "/api/matches", {
        token: owner,
        body: { versionId: draft.id, seatCount, options: {} },
      }),
      201,
    ),
  );
  const seats: SeatAuth[] = [];
  for (const invite of created.invites) {
    const token = invite.url.slice(`${WEB_ORIGIN}/join/`.length);
    const isOwner = invite.seat === "0";
    const claimed = ClaimInviteResponseSchema.parse(
      await ok(
        await server.call("POST", `/api/invites/${token}/claim`, {
          ...(isOwner ? { token: owner } : {}),
          body: { displayName: isOwner ? "Owner" : `Guest ${invite.seat}` },
        }),
        200,
      ),
    );
    seats.push(
      isOwner ? { kind: "user", token: owner } : { kind: "guest", token: claimed.guestToken ?? "" },
    );
  }
  if (options.start ?? true) {
    await ok(
      await server.call("POST", `/api/matches/${created.match.id}/start`, {
        token: owner,
        body: {},
      }),
      200,
    );
  }
  const [row] = await env.connection.db
    .select({ seed: matches.seed, options: matches.options })
    .from(matches)
    .where(eq(matches.id, created.match.id));
  if (!row) throw new Error("Missing match");
  return {
    matchId: created.match.id,
    versionId: draft.id,
    buildHash: version.buildHash,
    owner,
    seats,
    seed: row.seed,
    options: row.options as ActiveMatch["options"],
  };
}

type Of<T extends ServerMessage["t"]> = Extract<ServerMessage, { t: T }>;

/**
 * A spy client on Node's built-in WebSocket. Every frame must parse as a protocol server
 * message; raw frames are kept for leak scans.
 */
export class TestClient {
  readonly frames: string[] = [];
  readonly invalid: string[] = [];
  private readonly unread: ServerMessage[] = [];
  private waiter: (() => void) | undefined;
  closeCode: number | null = null;
  readonly closedPromise: Promise<number>;

  private constructor(private readonly socket: WebSocket) {
    this.closedPromise = new Promise((resolve) => {
      socket.addEventListener("close", (event) => {
        this.closeCode = event.code;
        this.waiter?.();
        resolve(event.code);
      });
    });
    socket.addEventListener("message", (event) => {
      const text = String(event.data);
      this.frames.push(text);
      const parsed = ServerMessageSchema.safeParse(JSON.parse(text));
      if (!parsed.success) this.invalid.push(text);
      else this.unread.push(parsed.data);
      this.waiter?.();
    });
  }

  static open(url: string): Promise<TestClient> {
    const socket = new WebSocket(url);
    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve(new TestClient(socket)), { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket failed")), {
        once: true,
      });
    });
  }

  send(message: unknown): void {
    this.socket.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  sendBinary(bytes: Uint8Array): void {
    this.socket.send(bytes);
  }

  close(): Promise<number> {
    this.socket.close();
    return this.closedPromise;
  }

  /** Removes and returns the first unread message of type `t` matching `where`. */
  take<T extends ServerMessage["t"]>(
    t: T,
    where: (message: Of<T>) => boolean = () => true,
    timeoutMs = 5000,
  ): Promise<Of<T>> {
    return this.takeWhere(
      (message): message is Of<T> => message.t === t && where(message as Of<T>),
      timeoutMs,
      t,
    );
  }

  async takeWhere<M extends ServerMessage>(
    where: (message: ServerMessage) => message is M,
    timeoutMs = 5000,
    label = "matching",
  ): Promise<M> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const index = this.unread.findIndex(where);
      if (index >= 0) return this.unread.splice(index, 1)[0] as M;
      const left = deadline - performance.now();
      if (left <= 0 || this.closeCode !== null) {
        const unread = this.unread.map((message) => message.t).join(",");
        throw new Error(`No ${label} message (closed: ${this.closeCode}); unread: ${unread}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiter = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.waiter = undefined;
    }
  }

  /** Unread messages of one type, without consuming them. */
  peek<T extends ServerMessage["t"]>(t: T): Of<T>[] {
    return this.unread.filter((message): message is Of<T> => message.t === t);
  }

  /** Discards every unread message of the given types. */
  drop(...types: ServerMessage["t"][]): void {
    for (let index = this.unread.length - 1; index >= 0; index--) {
      const message = this.unread[index];
      if (message && types.includes(message.t)) this.unread.splice(index, 1);
    }
  }
}

/** Opens a connection and completes `hello` → `welcome` for one seat. */
export async function join(
  server: RoomServer,
  matchId: string,
  auth: SeatAuth,
  lastSeq?: number,
): Promise<{ client: TestClient; welcome: Of<"welcome"> }> {
  const client = await TestClient.open(server.url);
  client.send({
    t: "hello",
    protocol: 1,
    matchId,
    auth,
    ...(lastSeq === undefined ? {} : { lastSeq }),
  });
  return { client, welcome: await client.take("welcome") };
}

/** Applies welcome, patches and snapshots the way a browser client would. */
export class ViewTracker {
  seq: number;
  view: ClientView;

  constructor(welcome: Of<"welcome">) {
    this.seq = welcome.seq;
    this.view = structuredClone(welcome.view);
  }

  apply(message: Of<"patch"> | Of<"snapshot">): void {
    if (message.t === "snapshot") {
      this.seq = message.seq;
      this.view = structuredClone(message.view);
      return;
    }
    if (message.seq !== this.seq + 1) throw new Error(`Gap: ${this.seq} → ${message.seq}`);
    const ops = message.ops as jsonpatch.Operation[];
    this.view = jsonpatch.applyPatch(structuredClone(this.view), ops, true, false)
      .newDocument as ClientView;
    this.seq = message.seq;
  }
}

/** Waits for the next view change (patch or snapshot) with the given sequence number. */
export function nextUpdate(client: TestClient, seq: number) {
  return client.takeWhere(
    (message): message is Of<"patch"> | Of<"snapshot"> =>
      (message.t === "patch" || message.t === "snapshot") && message.seq === seq,
    5000,
    `update ${seq}`,
  );
}

export type { JsonPatchOperation };
