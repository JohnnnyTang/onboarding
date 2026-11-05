// Service worker for offline use of the production build (T15: projects work with the
// network disabled). Registered by main.tsx in production only. It must stay free of imports:
// the build emits it as a standalone classic script, `/sw.js`.
//
// - Install caches every file of this build (the list is injected by the build).
// - Same-origin GET requests for those files are served from the cache.
// - Navigations go to the network first, so an online visit always gets the newest app,
//   and fall back to the cached app shell when the network is unreachable.
// - Anything else, including every cross-origin request (API, room server, sign-in), is
//   left to the browser untouched. Nothing is cached at runtime.

/** Replaced at build time with the JSON list of this build's files (see vite.config.ts). */
const PRECACHE: readonly string[] = JSON.parse("__BGP_PRECACHE_MANIFEST__") as string[];
/** Replaced at build time with a hash of the build's contents. */
const VERSION = "__BGP_PRECACHE_VERSION__";
const CACHE = `bgp-app-${VERSION}`;
const SHELL = "/index.html";

// The web app is typed with the DOM library; only these service worker members are used.
interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(response: Promise<Response>): void;
}
interface ServiceWorkerScope {
  readonly location: Location;
  skipWaiting(): Promise<void>;
  readonly clients: { claim(): Promise<void> };
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: FetchEvent) => void): void;
}

const scope = globalThis as unknown as ServiceWorkerScope;
const precached = new Set(PRECACHE.map((path) => new URL(path, scope.location.origin).pathname));

scope.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([...precached]))
      .then(() => scope.skipWaiting()),
  );
});

scope.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("bgp-app-") && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => scope.clients.claim()),
  );
});

async function fromCache(request: Request | string): Promise<Response | undefined> {
  return (await caches.open(CACHE)).match(request);
}

scope.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== scope.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => (await fromCache(SHELL)) ?? Response.error()),
    );
    return;
  }
  if (!precached.has(url.pathname)) return;
  event.respondWith(fromCache(url.pathname).then((cached) => cached ?? fetch(request)));
});
