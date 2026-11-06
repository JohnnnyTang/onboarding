import type { WebConfig } from "../config.js";

/**
 * The `bgp dev` server's origins (Q-030): the `/dev` page fetches the game and its build
 * events from it and shows its assets. Only plain-http loopback origins, any port.
 */
export const DEV_SERVER_SOURCES = [
  "http://localhost:*",
  "http://127.0.0.1:*",
  "http://[::1]:*",
] as const;

export type PolicyDelivery = "header" | "meta";

const unique = (values: readonly string[]) => [...new Set(values)];

/** A configured URL's origin, as a CSP source expression. */
function origin(url: string): string {
  return new URL(url).origin;
}

/**
 * The web app's content security policy (T20, Q-018, Q-020, Q-030), built from the same
 * `VITE_*` settings as the app.
 *
 * - Scripts only from the app's own origin, plus `blob:`: the game worker evaluates the game
 *   bundle as a blob module after its lockdown. No `'unsafe-inline'`, no `'unsafe-eval'`
 *   (the table loads `pixi.js/unsafe-eval` so PixiJS needs no `new Function`) and no
 *   `'wasm-unsafe-eval'`: the web app ships no WebAssembly (AC-14).
 * - Workers from the app (the game worker, the offline service worker) and `blob:`.
 * - Network: the API, the room server and the OIDC issuer, `blob:`/`data:` for local assets,
 *   and the loopback `bgp dev` server.
 * - Images: the app, `blob:` and `data:` (imported and generated card art, game assets) and
 *   the loopback dev server.
 *
 * A `<meta>` policy cannot carry `frame-ancestors` (browsers ignore it there), so only the
 * header form includes it.
 */
export function contentSecurityPolicy(
  config: Pick<WebConfig, "apiUrl" | "wsUrl" | "oidcIssuer">,
  delivery: PolicyDelivery,
): string {
  const directives: [string, ...string[]][] = [
    ["default-src", "'self'"],
    ["script-src", "'self'", "blob:"],
    ["worker-src", "'self'", "blob:"],
    [
      "connect-src",
      ...unique(["'self'", origin(config.apiUrl), origin(config.wsUrl), origin(config.oidcIssuer)]),
      "blob:",
      "data:",
      ...DEV_SERVER_SOURCES,
    ],
    ["img-src", "'self'", "blob:", "data:", ...DEV_SERVER_SOURCES],
    ["font-src", "'self'"],
    ["style-src", "'self'"],
    ["object-src", "'none'"],
    ["base-uri", "'none'"],
    ["form-action", "'self'"],
  ];
  if (delivery === "header") directives.push(["frame-ancestors", "'none'"]);
  return directives.map((directive) => directive.join(" ")).join("; ");
}

/**
 * The policy for the game worker's own script. A worker loaded from a URL gets the policy
 * sent with that response, not the page's, so a host that sends this header for the worker
 * leaves game code no network, images or nested workers even if the lockdown missed a door.
 * It needs only its own chunks and the game bundle's blob module.
 */
export const GAME_WORKER_POLICY = "default-src 'none'; script-src 'self' blob:";

/** Built names of the game worker's script (`assets/game-worker-<hash>.js`). */
export const GAME_WORKER_SCRIPT = /^\/assets\/game-worker-[A-Za-z0-9_-]+\.js$/;
