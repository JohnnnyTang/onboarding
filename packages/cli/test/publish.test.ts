import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SignInError, signInWithDeviceCode } from "../src/auth.js";
import { PublishError, publishGame } from "../src/publish.js";
import { starter } from "./fixtures.js";

const ISSUER = "http://idp.test/realms/bgp";
const API = "http://api.test";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fake OIDC provider: discovery, device authorization, then the given token replies. */
function provider(replies: { status: number; body: unknown }[]) {
  const forms: URLSearchParams[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return json({
        device_authorization_endpoint: `${ISSUER}/device-auth`,
        token_endpoint: `${ISSUER}/token`,
      });
    }
    forms.push(new URLSearchParams(String(init?.body)));
    if (url.endsWith("/device-auth")) {
      return json({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: `${ISSUER}/device`,
        verification_uri_complete: `${ISSUER}/device?user_code=ABCD-EFGH`,
        expires_in: 60,
        interval: 1,
      });
    }
    const reply = replies.shift();
    if (!reply) throw new Error("No more token replies");
    return json(reply.body, reply.status);
  };
  return { fetchImpl, forms };
}

describe("signInWithDeviceCode", () => {
  it("shows the code, polls while pending and slows down when asked", async () => {
    const { fetchImpl, forms } = provider([
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "slow_down" } },
      { status: 200, body: { access_token: "token-1", token_type: "Bearer" } },
    ]);
    const waits: number[] = [];
    const prompts: unknown[] = [];
    const token = await signInWithDeviceCode({
      issuer: ISSUER,
      clientId: "bgp-cli",
      prompt: (verification) => prompts.push(verification),
      fetch: fetchImpl,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(token).toBe("token-1");
    expect(prompts).toEqual([
      {
        url: `${ISSUER}/device`,
        code: "ABCD-EFGH",
        completeUrl: `${ISSUER}/device?user_code=ABCD-EFGH`,
      },
    ]);
    expect(waits).toEqual([1000, 1000, 6000]);
    expect(forms[0]?.get("client_id")).toBe("bgp-cli");
    expect(forms[1]?.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(forms[1]?.get("device_code")).toBe("device-secret");
  });

  it("reports a declined sign-in and an unreachable provider", async () => {
    const declined = provider([{ status: 400, body: { error: "access_denied" } }]);
    const options = {
      issuer: ISSUER,
      clientId: "bgp-cli",
      prompt: () => {},
      sleep: async () => {},
    };
    await expect(signInWithDeviceCode({ ...options, fetch: declined.fetchImpl })).rejects.toThrow(
      "Sign-in was declined",
    );
    const down: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(signInWithDeviceCode({ ...options, fetch: down })).rejects.toBeInstanceOf(
      SignInError,
    );
  });
});

interface FakeVersion {
  id: string;
  manifest: { version: string };
  status: "draft" | "ready" | "failed";
  buildHash: string | null;
  files: Map<string, string>;
}

/** An in-memory platform API implementing the upload flow's endpoints. */
function platform() {
  const games: { id: string; slug: string; name: string; visibility: string }[] = [];
  const versions = new Map<string, FakeVersion & { gameId: string }>();
  const requests: string[] = [];
  const view = (v: FakeVersion & { gameId: string }) => ({
    id: v.id,
    gameId: v.gameId,
    manifest: v.manifest,
    status: v.status,
    buildHash: v.buildHash,
    validationErrors: null,
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url.pathname}`);
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") !== "Bearer token-1") {
      return json({ error: { code: "UNAUTHORIZED", message: "Sign in first" } }, 401);
    }
    const path = url.pathname;
    if (method === "GET" && path === "/api/games") return json({ items: games, cursor: null });
    if (method === "POST" && path === "/api/games") {
      const body = JSON.parse(String(init?.body));
      const game = { id: `game-${games.length + 1}`, ...body };
      games.push(game);
      return json(game, 201);
    }
    const gameMatch = /^\/api\/games\/([^/]+)(\/versions)?$/.exec(path);
    if (gameMatch?.[1]) {
      const game = games.find((candidate) => candidate.id === gameMatch[1]);
      if (!game) return json({ error: { code: "NOT_FOUND", message: "No game" } }, 404);
      if (method === "GET") {
        const owned = [...versions.values()].filter((v) => v.gameId === game.id).map(view);
        return json({ ...game, versions: owned });
      }
      const manifest = JSON.parse(String(init?.body));
      const version = {
        id: `version-${versions.size + 1}`,
        gameId: game.id,
        manifest,
        status: "draft" as const,
        buildHash: null,
        files: new Map<string, string>(),
      };
      versions.set(version.id, version);
      return json(view(version), 201);
    }
    const fileMatch = /^\/api\/versions\/([^/]+)\/files\/(.+)$/.exec(path);
    if (method === "PUT" && fileMatch?.[1] && fileMatch[2]) {
      const version = versions.get(fileMatch[1]);
      const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (!version || digest !== headers.get("x-content-sha256")) {
        return json({ error: { code: "VALIDATION_FAILED", message: "Bad digest" } }, 400);
      }
      version.files.set(decodeURIComponent(fileMatch[2]), digest);
      return new Response(null, { status: 204 });
    }
    const finalizeMatch = /^\/api\/versions\/([^/]+)\/finalize$/.exec(path);
    if (method === "POST" && finalizeMatch?.[1]) {
      const version = versions.get(finalizeMatch[1]);
      if (!version) return json({ error: { code: "NOT_FOUND", message: "No version" } }, 404);
      const lines = [...version.files].sort(([a], [b]) => (a < b ? -1 : 1));
      const hash = createHash("sha256")
        .update(lines.map(([file, digest]) => `${file}\t${digest}\n`).join(""))
        .digest("hex");
      version.status = "ready";
      version.buildHash = hash;
      return json({ buildHash: hash });
    }
    const versionMatch = /^\/api\/versions\/([^/]+)$/.exec(path);
    if (method === "GET" && versionMatch?.[1]) {
      const version = versions.get(versionMatch[1]);
      return version
        ? json(view(version))
        : json({ error: { code: "NOT_FOUND", message: "No version" } }, 404);
    }
    return json({ error: { code: "NOT_FOUND", message: `No route ${method} ${path}` } }, 404);
  };
  return { fetchImpl, games, versions, requests };
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe("publishGame", () => {
  it("creates the game and a version, uploads every file and finalizes", async () => {
    const pkg = await starter();
    cleanup = pkg.cleanup;
    const api = platform();
    const options = {
      apiOrigin: API,
      token: "token-1",
      visibility: "private" as const,
      fetch: api.fetchImpl,
    };
    const result = await publishGame(await pkg.load(), options);
    expect(result.status).toBe("published");
    expect(result.version.status).toBe("ready");
    expect(result.version.buildHash).toBe(result.buildHash);
    expect(api.games).toEqual([
      { id: "game-1", slug: "test-game", name: "Test Game", visibility: "private" },
    ]);
    const uploaded = [...(api.versions.get("version-1")?.files.keys() ?? [])].sort();
    expect(uploaded).toEqual([
      "assets/card-1.png",
      "assets/card-2.png",
      "assets/card-3.png",
      "assets/card-4.png",
      "assets/card-5.png",
      "assets/card-6.png",
      "assets/card-7.png",
      "assets/card-8.png",
      "assets/card-9.png",
      "assets/card-back.png",
      "components.json",
      "dist/game.js",
    ]);

    // Identical files again: nothing is uploaded.
    const again = await publishGame(await pkg.load(), options);
    expect(again).toMatchObject({ status: "unchanged", buildHash: result.buildHash });
    expect(api.versions.size).toBe(1);

    // Changed files under the same version number: refused.
    await pkg.edit("src/rules.ts", "const COPIES = 2;", "const COPIES = 3;");
    await expect(publishGame(await pkg.load(), options)).rejects.toThrow(/raise "version"/);
    await pkg.edit("bgp.json", '"version": "0.1.0"', '"version": "0.1.1"');
    const next = await publishGame(await pkg.load(), options);
    expect(next.status).toBe("published");
    expect(next.buildHash).not.toBe(result.buildHash);
    expect(api.games).toHaveLength(1);
  });

  it("passes on the server's errors", async () => {
    const pkg = await starter();
    cleanup = pkg.cleanup;
    const api = platform();
    const error = await publishGame(await pkg.load(), {
      apiOrigin: API,
      token: "wrong",
      visibility: "private",
      fetch: api.fetchImpl,
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(PublishError);
    expect((error as Error).message).toBe("Sign in first");
  });

  it("refuses a package with errors before signing in to the API", async () => {
    const pkg = await starter();
    cleanup = pkg.cleanup;
    await pkg.edit("components.json", '"assets/card-9.png"', '"assets/missing.png"');
    const api = platform();
    await expect(
      publishGame(await pkg.load(), {
        apiOrigin: API,
        token: "token-1",
        visibility: "private",
        fetch: api.fetchImpl,
      }),
    ).rejects.toThrow("The package has errors");
    expect(api.requests).toEqual([]);
  });
});
