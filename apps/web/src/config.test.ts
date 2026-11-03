import { describe, expect, test } from "vitest";
import { DEFAULT_WEB_CONFIG, loadWebConfig } from "./config";

describe("web config", () => {
  test("defaults match the local development services", () => {
    expect(loadWebConfig({})).toEqual(DEFAULT_WEB_CONFIG);
    expect(loadWebConfig({ VITE_API_URL: "" })).toEqual(DEFAULT_WEB_CONFIG);
  });

  test("reads VITE_* settings and normalizes trailing slashes", () => {
    expect(
      loadWebConfig({
        VITE_API_URL: "https://api.example.test/",
        VITE_WS_URL: "wss://api.example.test/ws",
        VITE_OIDC_ISSUER: "https://id.example.test/realms/bgp/",
        VITE_OIDC_CLIENT_ID: "web",
      }),
    ).toEqual({
      apiUrl: "https://api.example.test",
      wsUrl: "wss://api.example.test/ws",
      oidcIssuer: "https://id.example.test/realms/bgp",
      oidcClientId: "web",
    });
  });

  test.each([
    [{ VITE_API_URL: "localhost:3000" }, /VITE_API_URL/],
    [{ VITE_API_URL: "ftp://api.example.test" }, /VITE_API_URL/],
    [{ VITE_WS_URL: "http://api.example.test/ws" }, /VITE_WS_URL/],
    [{ VITE_OIDC_ISSUER: true }, /VITE_OIDC_ISSUER/],
  ])("rejects %o", (env, message) => {
    expect(() => loadWebConfig(env)).toThrow(message);
  });
});
