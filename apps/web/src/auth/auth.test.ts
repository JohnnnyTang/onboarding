import { InMemoryWebStorage, User, UserManager } from "oidc-client-ts";
import { describe, expect, test, vi } from "vitest";
import { DEFAULT_WEB_CONFIG } from "../config";
import { createAuthService, type OidcManager, oidcSettings, safeReturnTo } from "./auth";
import { createClaimedSeats, createTokenSource } from "./claimed-seats";

const NOW = () => Math.floor(Date.now() / 1000);

function oidcUser(overrides: { expiresAt?: number; state?: unknown; name?: string } = {}): User {
  return new User({
    access_token: "access-token",
    id_token: "id-token",
    refresh_token: "refresh-token",
    token_type: "Bearer",
    scope: "openid profile email",
    profile: {
      sub: "subject-1",
      iss: DEFAULT_WEB_CONFIG.oidcIssuer,
      aud: "bgp-web",
      exp: NOW() + 300,
      iat: NOW(),
      name: overrides.name ?? "Designer One",
      preferred_username: "designer1",
    },
    expires_at: overrides.expiresAt ?? NOW() + 300,
    userState: overrides.state,
  });
}

function fakeManager() {
  const handlers = {
    loaded: [] as ((user: User) => void)[],
    unloaded: [] as (() => void)[],
    expired: [] as (() => void)[],
  };
  const manager = {
    signinRedirect: vi.fn(async (_args: { state: unknown }) => {}),
    signinRedirectCallback: vi.fn(async (_url: string) =>
      oidcUser({ state: { returnTo: "/games" } }),
    ),
    signoutRedirect: vi.fn(async (_args: { id_token_hint?: string }) => {}),
    removeUser: vi.fn(async () => {}),
    events: {
      addUserLoaded: (callback: (user: User) => void) => handlers.loaded.push(callback),
      addUserUnloaded: (callback: () => void) => handlers.unloaded.push(callback),
      addAccessTokenExpired: (callback: () => void) => handlers.expired.push(callback),
    },
  } satisfies OidcManager;
  return { manager, handlers };
}

describe("OIDC settings", () => {
  test("keep tokens in memory and only the transient sign-in request in the given store", () => {
    const transient = new InMemoryWebStorage();
    const settings = oidcSettings(DEFAULT_WEB_CONFIG, "http://localhost:5173", transient);
    expect(settings).toMatchObject({
      authority: "http://localhost:8080/realms/bgp",
      client_id: "bgp-web",
      redirect_uri: "http://localhost:5173/auth/callback",
      post_logout_redirect_uri: "http://localhost:5173/",
      response_type: "code",
      scope: "openid profile email",
      monitorSession: false,
    });
    // The real UserManager accepts these settings and keeps the user store in memory.
    const manager = new UserManager(settings);
    const userStore = manager.settings.userStore as unknown as { _store: unknown };
    const stateStore = manager.settings.stateStore as unknown as { _store: unknown };
    expect(userStore._store).toBeInstanceOf(InMemoryWebStorage);
    expect(userStore._store).not.toBe(transient);
    expect(stateStore._store).toBe(transient);
    // UserManager is our OidcManager.
    const typed: OidcManager = manager;
    expect(typed).toBe(manager);
  });
});

describe("return paths", () => {
  test.each([
    ["/games", "/games"],
    ["/matches/m-1/lobby?tab=seats", "/matches/m-1/lobby?tab=seats"],
    ["https://evil.example/", "/"],
    ["//evil.example/", "/"],
    ["/\\evil.example", "/"],
    ["games", "/"],
    ["/auth/callback?code=x", "/"],
    [42, "/"],
    [undefined, "/"],
  ])("%s → %s", (input, expected) => {
    expect(safeReturnTo(input)).toBe(expected);
  });
});

describe("auth service", () => {
  test("signs in with a safe return path and exposes the user without tokens", async () => {
    const { manager } = fakeManager();
    const auth = createAuthService(manager);
    const listener = vi.fn();
    auth.subscribe(listener);
    expect(auth.current()).toBeNull();
    expect(auth.accessToken()).toBeNull();

    await auth.signIn("//evil.example");
    expect(manager.signinRedirect).toHaveBeenCalledWith({ state: { returnTo: "/" } });

    await expect(auth.completeSignIn("http://localhost:5173/auth/callback?code=c")).resolves.toBe(
      "/games",
    );
    expect(auth.current()).toEqual({ subject: "subject-1", name: "Designer One" });
    expect(JSON.stringify(auth.current())).not.toContain("token");
    expect(auth.accessToken()).toBe("access-token");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("redeems each callback URL once, even when effects run twice", async () => {
    const { manager } = fakeManager();
    const auth = createAuthService(manager);
    const url = "http://localhost:5173/auth/callback?code=c&state=s";
    const [first, second] = await Promise.all([auth.completeSignIn(url), auth.completeSignIn(url)]);
    expect(first).toBe(second);
    expect(manager.signinRedirectCallback).toHaveBeenCalledTimes(1);
  });

  test("an unsafe return path in the callback state falls back to home", async () => {
    const { manager } = fakeManager();
    manager.signinRedirectCallback.mockResolvedValueOnce(
      oidcUser({ state: { returnTo: "https://evil.example" } }),
    );
    const auth = createAuthService(manager);
    await expect(auth.completeSignIn("http://localhost:5173/auth/callback?x")).resolves.toBe("/");
  });

  test("token renewals keep the snapshot; expiry and unload sign out", async () => {
    const { manager, handlers } = fakeManager();
    const auth = createAuthService(manager);
    const listener = vi.fn();
    auth.subscribe(listener);
    for (const handler of handlers.loaded) handler(oidcUser());
    const snapshot = auth.current();
    for (const handler of handlers.loaded) handler(oidcUser());
    expect(auth.current()).toBe(snapshot);
    expect(listener).toHaveBeenCalledTimes(1);

    for (const handler of handlers.expired) handler();
    await vi.waitFor(() => expect(auth.current()).toBeNull());
    expect(manager.removeUser).toHaveBeenCalled();
    expect(auth.accessToken()).toBeNull();

    for (const handler of handlers.loaded) handler(oidcUser());
    for (const handler of handlers.unloaded) handler();
    expect(auth.current()).toBeNull();
  });

  test("an expired access token is never handed out", () => {
    const { manager, handlers } = fakeManager();
    const auth = createAuthService(manager);
    for (const handler of handlers.loaded) handler(oidcUser({ expiresAt: NOW() - 10 }));
    expect(auth.current()).not.toBeNull();
    expect(auth.accessToken()).toBeNull();
  });

  test("sign-out drops the user before redirecting to the provider", async () => {
    const { manager, handlers } = fakeManager();
    const auth = createAuthService(manager);
    for (const handler of handlers.loaded) handler(oidcUser());
    await auth.signOut();
    expect(manager.removeUser).toHaveBeenCalled();
    expect(manager.signoutRedirect).toHaveBeenCalledWith({ id_token_hint: "id-token" });
    expect(auth.current()).toBeNull();
    expect(auth.accessToken()).toBeNull();
  });
});

describe("token source", () => {
  test("uses a guest token only for its own match, else the designer token", async () => {
    const { manager, handlers } = fakeManager();
    const auth = createAuthService(manager);
    const seats = createClaimedSeats();
    const tokens = createTokenSource(auth, seats);
    expect(tokens.tokenFor({})).toBeNull();
    expect(tokens.tokenFor({ matchId: "m-1" })).toBeNull();

    seats.set({ matchId: "m-1", seat: "0", displayName: "Tess", guestToken: "guest-1" });
    expect(tokens.tokenFor({ matchId: "m-1" })).toBe("guest-1");
    expect(tokens.tokenFor({ matchId: "m-2" })).toBeNull();
    expect(tokens.tokenFor({})).toBeNull();

    for (const handler of handlers.loaded) handler(oidcUser());
    expect(tokens.tokenFor({ matchId: "m-1" })).toBe("guest-1");
    expect(tokens.tokenFor({ matchId: "m-2" })).toBe("access-token");
    expect(tokens.tokenFor({})).toBe("access-token");

    seats.set({ matchId: "m-3", seat: "1", displayName: "Designer", guestToken: null });
    expect(tokens.tokenFor({ matchId: "m-3" })).toBe("access-token");
  });
});
