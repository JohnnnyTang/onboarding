import { describe, expect, test } from "vitest";
import { DEFAULT_WEB_CONFIG } from "../config";
import {
  contentSecurityPolicy,
  GAME_WORKER_POLICY,
  GAME_WORKER_SCRIPT,
} from "./content-security-policy";

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split("; ").map((directive) => {
      const [name = "", ...sources] = directive.split(" ");
      return [name, sources];
    }),
  );
}

describe("content security policy", () => {
  const production = {
    apiUrl: "https://api.example.test",
    wsUrl: "wss://room.example.test/ws",
    oidcIssuer: "https://id.example.test/realms/bgp",
  };

  test("allows the configured API, room and OIDC origins for connections only", () => {
    const policy = directives(contentSecurityPolicy(production, "header"));
    expect(policy.get("connect-src")).toEqual(
      expect.arrayContaining([
        "'self'",
        "https://api.example.test",
        "wss://room.example.test",
        "https://id.example.test",
      ]),
    );
    expect(policy.get("script-src")).toEqual(["'self'", "blob:"]);
    expect(policy.get("img-src")).not.toContain("https://api.example.test");
  });

  test("allows the game worker's blob module and the service worker (Q-020)", () => {
    const policy = directives(contentSecurityPolicy(production, "header"));
    expect(policy.get("worker-src")).toEqual(["'self'", "blob:"]);
  });

  test("allows the loopback bgp dev server for fetches and images (Q-030)", () => {
    const policy = directives(contentSecurityPolicy(production, "meta"));
    for (const name of ["connect-src", "img-src"]) {
      expect(policy.get(name)).toEqual(
        expect.arrayContaining(["http://localhost:*", "http://127.0.0.1:*", "http://[::1]:*"]),
      );
    }
  });

  test("never allows inline script, eval or WebAssembly compilation", () => {
    const text = contentSecurityPolicy(DEFAULT_WEB_CONFIG, "header");
    expect(text).not.toMatch(/unsafe-inline|unsafe-eval|'strict-dynamic'/);
    // No bare wildcard source (port wildcards on loopback are fine).
    expect(text).not.toMatch(/(^| )\*(;| |$)/);
    const policy = directives(text);
    expect(policy.get("object-src")).toEqual(["'none'"]);
    expect(policy.get("base-uri")).toEqual(["'none'"]);
  });

  test("puts frame-ancestors in the header only", () => {
    expect(directives(contentSecurityPolicy(production, "header")).get("frame-ancestors")).toEqual([
      "'none'",
    ]);
    expect(directives(contentSecurityPolicy(production, "meta")).has("frame-ancestors")).toBe(
      false,
    );
  });

  test("lists a shared origin once", () => {
    const policy = directives(contentSecurityPolicy(DEFAULT_WEB_CONFIG, "header"));
    const connect = policy.get("connect-src") ?? [];
    expect(connect.filter((source) => source === "http://localhost:3000")).toHaveLength(1);
    expect(connect).toContain("ws://localhost:3000");
  });

  test("gives the game worker no network and only its scripts", () => {
    expect(directives(GAME_WORKER_POLICY)).toEqual(
      new Map([
        ["default-src", ["'none'"]],
        ["script-src", ["'self'", "blob:"]],
      ]),
    );
    expect(GAME_WORKER_SCRIPT.test("/assets/game-worker-CXV9mSPe.js")).toBe(true);
    expect(GAME_WORKER_SCRIPT.test("/assets/game-worker-CXV9mSPe.js.map")).toBe(false);
    expect(GAME_WORKER_SCRIPT.test("/assets/index-abc.js")).toBe(false);
  });
});
