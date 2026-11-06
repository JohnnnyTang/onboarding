import { DevBuildEventSchema, DevGameResponseSchema } from "@bgp/schema";
import { afterEach, describe, expect, it } from "vitest";
import { type DevServer, startDevServer } from "../src/dev.js";
import { starter } from "./fixtures.js";

const WEB = "http://localhost:5173";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function serve() {
  const pkg = await starter();
  cleanups.push(pkg.cleanup);
  const server = await startDevServer(pkg.dir, { port: 0, webOrigin: WEB });
  cleanups.push(() => server.close());
  return { pkg, server };
}

async function game(server: DevServer) {
  const response = await fetch(`${server.origin}/game`);
  expect(response.headers.get("access-control-allow-origin")).toBe(WEB);
  return DevGameResponseSchema.parse(await response.json());
}

/** Reads server-sent `build` events until one satisfies `done`. */
async function nextBuild(server: DevServer, trigger: () => Promise<void>, minId: number) {
  const controller = new AbortController();
  const response = await fetch(`${server.origin}/events`, { signal: controller.signal });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No event stream");
  const decoder = new TextDecoder();
  let buffer = "";
  // The stream opens with a comment; trigger the change once it is connected.
  await reader.read();
  await trigger();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error("Event stream ended");
      buffer += decoder.decode(value, { stream: true });
      for (const match of buffer.matchAll(/event: build\ndata: (.*)\n\n/g)) {
        const event = DevBuildEventSchema.parse(JSON.parse(match[1] ?? ""));
        if (event.buildId >= minId) return event;
      }
    }
  } finally {
    controller.abort();
  }
}

describe("bgp dev server", () => {
  it("serves the built game and only the assets the components reference", async () => {
    const { server } = await serve();
    expect(server.pageUrl).toBe(`${WEB}/dev?game=${encodeURIComponent(server.origin)}`);
    const first = await game(server);
    expect(first).toMatchObject({ protocol: 1, buildId: 0, errors: [] });
    expect(first.source).toMatch(/as default/);
    const art = await fetch(`${server.origin}/assets/card-3.png`);
    expect(art.status).toBe(200);
    expect(art.headers.get("content-type")).toBe("image/png");
    expect(art.headers.get("access-control-allow-origin")).toBe(WEB);
    for (const path of ["/bgp.json", "/src/rules.ts", "/assets/../bgp.json", "/package.json"]) {
      expect((await fetch(`${server.origin}${path}`)).status, path).toBe(404);
    }
  });

  it("rebuilds on change, reports a broken build and recovers", async () => {
    const { pkg, server } = await serve();
    const broken = await nextBuild(
      server,
      () => pkg.edit("src/rules.ts", "const COPIES = 2;", "const COPIES = ;"),
      1,
    );
    let current = await game(server);
    expect(current.buildId).toBe(broken.buildId);
    expect(current.source).toBeNull();
    expect(current.errors[0]?.message).toMatch(/src[\\/]rules\.ts:\d+:\d+: /);
    const fixed = await nextBuild(
      server,
      () => pkg.edit("src/rules.ts", "const COPIES = ;", "const COPIES = 3;"),
      broken.buildId + 1,
    );
    current = await game(server);
    expect(current.buildId).toBe(fixed.buildId);
    expect(current.errors).toEqual([]);
    expect(current.source).toMatch(/COPIES = 3/);
  });

  it("keeps the last good package when bgp.json breaks", async () => {
    const { pkg, server } = await serve();
    await pkg.edit("bgp.json", '"version": "0.1.0"', '"version": "one"');
    const current = await server.rebuild();
    expect(current.manifest.version).toBe("0.1.0");
    expect(current.source).toBeNull();
    expect(current.errors).toContainEqual(expect.objectContaining({ path: "bgp.json.version" }));
  });
});
