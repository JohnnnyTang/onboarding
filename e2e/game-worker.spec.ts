import { expect, test } from "@playwright/test";
import { createEnforcedMatch, designerToken, PNG, WEB_URL } from "./support/app.js";
import { joinAsGuest, prompt, startMatch } from "./support/harbor-market.js";

// T14 done-when: inside the real game worker, in each browser, game code cannot use fetch or
// indexedDB (D-007), and the other locked names behave as in the rules host. The probes are
// published games played through the match page; each reports what it could reach in its
// `present` prompt.

const PROBE = `
const probe = (name, read) => {
  try {
    const value = read();
    return name + ":" + (value === undefined ? "undefined" : "reachable");
  } catch {
    return name + ":blocked";
  }
};
const checks = () => [
  probe("fetch", () => fetch),
  probe("fetchCall", () => fetch("/api/healthz")),
  probe("selfFetch", () => self.fetch),
  probe("protoFetch", () => Object.getPrototypeOf(globalThis).fetch),
  probe("indexedDB", () => indexedDB),
  probe("indexedDBOpen", () => indexedDB.open("probe")),
  probe("XMLHttpRequest", () => new XMLHttpRequest()),
  probe("WebSocket", () => WebSocket),
  probe("EventSource", () => EventSource),
  probe("importScripts", () => importScripts),
  probe("caches", () => caches),
  probe("BroadcastChannel", () => BroadcastChannel),
  probe("navigator", () => navigator),
  probe("postMessage", () => postMessage),
  probe("Worker", () => Worker),
  probe("Date", () => Date.now()),
  probe("random", () => Math.random()),
  probe("setTimeout", () => setTimeout),
].join(" ");
const atLoad = checks();
export default {
  sdk: 1,
  setup: () => ({}),
  moves: {},
  playerView: () => ({}),
  present: () => ({
    table: { size_mm: [400, 300] },
    zones: [],
    items: [],
    prompt: atLoad + " | " + checks(),
  }),
};
`;

const LOOP = `
export default {
  sdk: 1,
  setup: () => ({}),
  moves: {},
  playerView: () => ({}),
  present: () => {
    for (;;) {}
  },
};
`;

const EXPECTED = [
  "fetch:blocked",
  "fetchCall:blocked",
  "selfFetch:blocked",
  "protoFetch:undefined",
  "indexedDB:undefined",
  "indexedDBOpen:blocked",
  "XMLHttpRequest:blocked",
  "WebSocket:blocked",
  "EventSource:blocked",
  "importScripts:undefined",
  "caches:undefined",
  "BroadcastChannel:undefined",
  "navigator:undefined",
  "postMessage:undefined",
  "Worker:blocked",
  "Date:blocked",
  "random:blocked",
  "setTimeout:blocked",
].join(" ");

const MANIFEST = {
  schemaVersion: 1,
  name: "Probe",
  version: "1.0.0",
  mode: "enforced",
  sdk: 1,
  players: { min: 1, max: 1 },
  entry: "game.js",
  components: "components.json",
};
const COMPONENTS = {
  schemaVersion: 1,
  defs: [{ id: "chip", kind: "token", shape: "circle", size_mm: [20, 20], front: "chip.png" }],
};

async function openProbe(browser: import("@playwright/test").Browser, source: string) {
  const token = await designerToken(browser, "designer2");
  const match = await createEnforcedMatch(
    token,
    {
      name: "Probe",
      manifest: MANIFEST,
      files: {
        "game.js": Buffer.from(source),
        "components.json": Buffer.from(JSON.stringify(COMPONENTS)),
        "chip.png": PNG,
      },
    },
    1,
  );
  const player = await joinAsGuest(browser, match, "0", "Probe");
  await startMatch(token, match.matchId);
  await expect(player.page).toHaveURL(`${WEB_URL}/matches/${match.matchId}`);
  return player;
}

test("game code in the worker cannot reach the network or storage", async ({ browser }) => {
  const { page, context } = await openProbe(browser, PROBE);
  const requests: string[] = [];
  context.on("request", (request) => requests.push(request.url()));
  await expect(prompt(page)).toHaveText(`${EXPECTED} | ${EXPECTED}`);
  expect(requests.filter((url) => url.includes("/api/healthz"))).toEqual([]);
  await context.close();
});

test("a game that never returns is stopped and reported", async ({ browser }) => {
  const { page, context } = await openProbe(browser, LOOP);
  await expect(page.getByRole("alert")).toHaveText("The game stopped responding");
  // The page itself stays responsive: chat still works.
  await page.getByLabel("Message").fill("still here");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("region", { name: "Chat" })).toContainText("still here");
  await context.close();
});
