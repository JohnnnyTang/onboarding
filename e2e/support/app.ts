import { createHash, randomBytes } from "node:crypto";
import { type Browser, expect, type Page } from "@playwright/test";

/** Must match the Keycloak bgp-web client's redirect origin. */
export const WEB_URL = "http://localhost:5173";
/** The API as seen from the test runner (the browser uses VITE_API_URL). */
export const API_URL = "http://127.0.0.1:3000";
export const ISSUER = process.env.OIDC_ISSUER ?? "http://localhost:8080/realms/bgp";

/** Fills Keycloak's login form; the test user's password equals the username. */
export async function keycloakLogin(page: Page, username: string): Promise<void> {
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(username);
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
}

/**
 * An access token for a test designer, obtained with the same PKCE flow the web app uses
 * (the realm disables password grants). Fixture setup uses it to call the API directly.
 */
export async function designerToken(browser: Browser, username: string): Promise<string> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(16).toString("hex");
    const redirect = `${WEB_URL}/e2e-fixture-callback`;
    let callbackUrl: string | undefined;
    await page.route(
      (url) => url.pathname.endsWith("/login-actions/authenticate"),
      async (route) => {
        const response = await route.fetch({ maxRedirects: 0 });
        callbackUrl = response.headers().location;
        await route.fulfill({ status: 200, contentType: "text/html", body: "Fixture callback" });
      },
    );
    const authorize = new URL(`${ISSUER}/protocol/openid-connect/auth`);
    authorize.search = new URLSearchParams({
      client_id: "bgp-web",
      response_type: "code",
      redirect_uri: redirect,
      scope: "openid profile email",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    await page.goto(authorize.href);
    await keycloakLogin(page, username);
    await expect(page.getByText("Fixture callback", { exact: true })).toBeVisible();
    const code = callbackUrl ? new URL(callbackUrl).searchParams.get("code") : null;
    if (!code) throw new Error("Missing authorization code");
    const response = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "bgp-web",
        redirect_uri: redirect,
        code,
        code_verifier: verifier,
      }),
    });
    const body = (await response.json()) as { access_token?: unknown };
    if (typeof body.access_token !== "string") throw new Error("Missing access token");
    return body.access_token;
  } finally {
    await context.close();
  }
}

async function api(token: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
  return text === "" ? undefined : JSON.parse(text);
}

/** A real 1×1 PNG for placeholder card art. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

export interface FixtureMatch {
  matchId: string;
  invites: { seat: string; url: string }[];
}

/**
 * Publishes a small sandbox game through the HTTP API (create, draft, upload, finalize) and
 * creates a lobby match with one invite per seat, as a designer would.
 */
export async function createSandboxMatch(token: string, seatCount: number): Promise<FixtureMatch> {
  const slug = `e2e-${randomBytes(6).toString("hex")}`;
  const components = {
    schemaVersion: 1,
    defs: [
      { id: "back", kind: "cardBack", image: "assets/back.png" },
      { id: "fish", kind: "card", size_mm: [63, 88], front: "assets/fish.png", back: "back" },
    ],
    zones: [
      {
        id: "deck",
        layout: "stack",
        rect_mm: { x: 0, y: 0, w: 100, h: 100 },
        visibility: "public",
      },
    ],
    setup: { instances: [{ def: "fish", zone: "deck", count: 4, face: "down" }] },
  };
  const files: Record<string, Buffer> = {
    "components.json": Buffer.from(JSON.stringify(components)),
    "assets/back.png": PNG,
    "assets/fish.png": PNG,
  };
  const game = (await api(token, "POST", "/api/games", {
    slug,
    name: "E2E Fish",
    visibility: "unlisted",
  })) as { id: string };
  const version = (await api(token, "POST", `/api/games/${game.id}/versions`, {
    schemaVersion: 1,
    id: slug,
    name: "E2E Fish",
    version: "0.1.0",
    mode: "sandbox",
    sdk: 1,
    players: { min: 1, max: 4 },
    components: "components.json",
  })) as { id: string };
  for (const [path, bytes] of Object.entries(files)) {
    const response = await fetch(`${API_URL}/api/versions/${version.id}/files/${path}`, {
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
  await api(token, "POST", `/api/versions/${version.id}/finalize`, {});
  const created = (await api(token, "POST", "/api/matches", {
    versionId: version.id,
    seatCount,
    options: {},
  })) as { match: { id: string }; invites: { seat: string; url: string }[] };
  return { matchId: created.match.id, invites: created.invites };
}

/** Everything in web storage, to check that no token was persisted. */
export function webStorage(page: Page): Promise<string> {
  return page.evaluate(() => {
    const dump = (storage: Storage) =>
      Array.from({ length: storage.length }, (_, index) => {
        const key = storage.key(index) ?? "";
        return `${key}=${storage.getItem(key) ?? ""}`;
      });
    return JSON.stringify([...dump(localStorage), ...dump(sessionStorage), document.cookie]);
  });
}
