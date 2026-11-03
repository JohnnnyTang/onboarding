import {
  InMemoryWebStorage,
  type User,
  type UserManagerSettings,
  WebStorageStateStore,
} from "oidc-client-ts";
import type { WebConfig } from "../config";

export const CALLBACK_PATH = "/auth/callback";

/** The signed-in designer as the UI sees it. Tokens are deliberately not part of it. */
export interface AuthUser {
  subject: string;
  name: string;
}

export interface AuthService {
  /** Stable snapshot for `useSyncExternalStore`. */
  current(): AuthUser | null;
  subscribe(listener: () => void): () => void;
  /** The access token, if signed in and not expired. Never stored outside memory. */
  accessToken(): string | null;
  signIn(returnTo: string): Promise<void>;
  /** Completes the redirect; resolves to the in-app path to return to. */
  completeSignIn(url: string): Promise<string>;
  signOut(): Promise<void>;
}

/** The part of oidc-client-ts's `UserManager` this app relies on. */
export interface OidcManager {
  signinRedirect(args: { state: unknown }): Promise<void>;
  signinRedirectCallback(url: string): Promise<User>;
  signoutRedirect(args: { id_token_hint?: string }): Promise<void>;
  removeUser(): Promise<void>;
  events: {
    addUserLoaded(callback: (user: User) => void): unknown;
    addUserUnloaded(callback: () => void): unknown;
    addAccessTokenExpired(callback: () => void): unknown;
  };
}

/**
 * Settings for the Keycloak `bgp-web` client: authorization code with PKCE (the library
 * default). The user, with its access and refresh tokens, lives only in memory (D-007).
 * The short-lived sign-in request state (PKCE verifier and return path) must survive the
 * redirect to the provider, so it goes to `transientStore` (session storage in the browser);
 * the library deletes it when the callback completes.
 */
export function oidcSettings(
  config: WebConfig,
  origin: string,
  transientStore: Storage,
): UserManagerSettings {
  return {
    authority: config.oidcIssuer,
    client_id: config.oidcClientId,
    redirect_uri: `${origin}${CALLBACK_PATH}`,
    post_logout_redirect_uri: `${origin}/`,
    response_type: "code",
    scope: "openid profile email",
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
    stateStore: new WebStorageStateStore({ store: transientStore, prefix: "bgp.oidc." }),
    automaticSilentRenew: true,
    loadUserInfo: false,
    monitorSession: false,
  };
}

/** Only same-app paths: never an absolute or protocol-relative URL (no open redirect). */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/")) return "/";
  if (value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (value === CALLBACK_PATH || value.startsWith(`${CALLBACK_PATH}?`)) return "/";
  return value;
}

function returnPath(state: unknown): string {
  if (typeof state === "object" && state !== null && "returnTo" in state) {
    return safeReturnTo(state.returnTo);
  }
  return "/";
}

function displayName(user: User): string {
  const { name, preferred_username: username, sub } = user.profile;
  return (typeof name === "string" && name) || (typeof username === "string" && username) || sub;
}

export function createAuthService(manager: OidcManager): AuthService {
  let user: User | null = null;
  let snapshot: AuthUser | null = null;
  const listeners = new Set<() => void>();
  const callbacks = new Map<string, Promise<string>>();

  function set(next: User | null): void {
    user = next;
    const updated = next ? { subject: next.profile.sub, name: displayName(next) } : null;
    // Token renewals keep the same snapshot, so subscribers only re-render on real changes.
    if (updated?.subject === snapshot?.subject && updated?.name === snapshot?.name) return;
    snapshot = updated;
    for (const listener of listeners) listener();
  }

  manager.events.addUserLoaded((loaded) => set(loaded));
  manager.events.addUserUnloaded(() => set(null));
  manager.events.addAccessTokenExpired(() => {
    // Silent renewal failed or was not possible; drop the stale tokens.
    void manager.removeUser().finally(() => set(null));
  });

  return {
    current: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    accessToken: () => (user && !user.expired ? user.access_token : null),
    signIn: (returnTo) => manager.signinRedirect({ state: { returnTo: safeReturnTo(returnTo) } }),
    completeSignIn(url) {
      // React's development double effects must not redeem the same code twice.
      let pending = callbacks.get(url);
      if (!pending) {
        pending = manager.signinRedirectCallback(url).then((signedIn) => {
          set(signedIn);
          return returnPath(signedIn.state);
        });
        callbacks.set(url, pending);
      }
      return pending;
    },
    async signOut() {
      const idToken = user?.id_token;
      await manager.removeUser();
      set(null);
      await manager.signoutRedirect(idToken ? { id_token_hint: idToken } : {});
    },
  };
}
