/** Web app settings from `VITE_*` variables (docs/dev-environment.md). */
export interface WebConfig {
  /** Origin of the HTTP API, without the `/api` prefix. */
  apiUrl: string;
  /** Room server WebSocket endpoint (used from T14). */
  wsUrl: string;
  oidcIssuer: string;
  oidcClientId: string;
}

export const DEFAULT_WEB_CONFIG: WebConfig = {
  apiUrl: "http://localhost:3000",
  wsUrl: "ws://localhost:3000/ws",
  oidcIssuer: "http://localhost:8080/realms/bgp",
  oidcClientId: "bgp-web",
};

function setting(env: Readonly<Record<string, unknown>>, name: string, fallback: string): string {
  const value = env[name];
  if (value === undefined || value === "") return fallback;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function url(name: string, value: string, protocols: readonly string[]): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${name} must use ${protocols.join(" or ")}`);
  }
  // Keep the path (issuer realms, /ws) but drop a trailing slash so joins stay predictable.
  return parsed.href.replace(/\/$/, "");
}

export function loadWebConfig(env: Readonly<Record<string, unknown>>): WebConfig {
  const clientId = setting(env, "VITE_OIDC_CLIENT_ID", DEFAULT_WEB_CONFIG.oidcClientId);
  return {
    apiUrl: url("VITE_API_URL", setting(env, "VITE_API_URL", DEFAULT_WEB_CONFIG.apiUrl), [
      "http:",
      "https:",
    ]),
    wsUrl: url("VITE_WS_URL", setting(env, "VITE_WS_URL", DEFAULT_WEB_CONFIG.wsUrl), [
      "ws:",
      "wss:",
    ]),
    oidcIssuer: url(
      "VITE_OIDC_ISSUER",
      setting(env, "VITE_OIDC_ISSUER", DEFAULT_WEB_CONFIG.oidcIssuer),
      ["http:", "https:"],
    ),
    oidcClientId: clientId,
  };
}
