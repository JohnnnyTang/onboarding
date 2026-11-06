import {
  DevBuildEventSchema,
  type DevGameResponse,
  DevGameResponseSchema,
  type HotSeatMatchRecord,
  HotSeatMatchRecordSchema,
} from "@bgp/schema";

// The web app's side of `bgp dev` (docs/contracts/dev-server.md).

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The dev server origin from the page's `game` parameter: a plain http origin on a loopback
 * host, or null. Anything else is refused, so a link cannot point the page at another site.
 */
export function devServerOrigin(param: string | null): string | null {
  if (!param) return null;
  let url: URL;
  try {
    url = new URL(param);
  } catch {
    return null;
  }
  const bare =
    url.protocol === "http:" &&
    LOOPBACK.has(url.hostname) &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "";
  return bare ? url.origin : null;
}

export class DevServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevServerError";
  }
}

/** Fetches and validates the game as last built. */
export async function fetchDevGame(
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DevGameResponse> {
  let body: unknown;
  try {
    const response = await fetchImpl(`${origin}/game`, { cache: "no-store" });
    if (!response.ok) throw new DevServerError(`bgp dev answered ${response.status}`);
    body = await response.json();
  } catch (error) {
    if (error instanceof DevServerError) throw error;
    throw new DevServerError(`Cannot reach bgp dev at ${origin}. Is it running?`);
  }
  const parsed = DevGameResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new DevServerError("bgp dev sent a response this web app does not understand");
  }
  return parsed.data;
}

/**
 * Calls `onChange` after each rebuild, and when the event stream (re)connects, since builds
 * may have happened while it was down. Returns a function that stops listening.
 */
export function watchDevBuilds(origin: string, onChange: () => void): () => void {
  const source = new EventSource(`${origin}/events`);
  source.addEventListener("open", onChange);
  source.addEventListener("build", (event) => {
    let data: unknown;
    try {
      data = JSON.parse((event as MessageEvent<string>).data);
    } catch {
      return;
    }
    if (DevBuildEventSchema.safeParse(data).success) onChange();
  });
  return () => source.close();
}

/** The URL of a referenced asset; the build ID makes the browser fetch changed art. */
export function devAssetUrl(origin: string, ref: string, buildId: number): string {
  const path = ref.split("/").map(encodeURIComponent).join("/");
  return `${origin}/${path}?build=${buildId}`;
}

const storageKey = (gameId: string) => `bgp.dev-match.${gameId}`;

/** The hot-seat match of this tab for a game under development, if it parses. */
export function loadDevMatch(gameId: string): HotSeatMatchRecord | null {
  try {
    const text = sessionStorage.getItem(storageKey(gameId));
    if (text === null) return null;
    const parsed = HotSeatMatchRecordSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function saveDevMatch(match: HotSeatMatchRecord, gameId: string): Promise<void> {
  sessionStorage.setItem(storageKey(gameId), JSON.stringify(match));
}
