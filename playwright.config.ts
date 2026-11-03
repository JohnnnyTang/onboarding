import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { e2eDatabaseUrl } from "./scripts/e2e-database.js";

// Same precedence as the dev launcher: existing environment values win over the root .env.
const envFile = fileURLToPath(new URL(".env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const reuseExistingServer = !process.env.CI;
const tableServer = {
  command: "pnpm dev:table",
  url: "http://127.0.0.1:4313/dev/table/",
  reuseExistingServer,
};

/**
 * The web app and API for app tests (e2e/web-app.spec.ts). They need PostgreSQL, Keycloak and
 * a prior `pnpm build`; set BGP_E2E_APP=0 to run only the renderer tests without them.
 * Playwright starts web servers in order, so the table build finishes before these start.
 */
function appServers() {
  // Playwright reads these settings directly; it never runs as a cached Turborepo task.
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: not a turbo task input
  if (process.env.BGP_E2E_APP === "0") return [];
  // Its own database (bgp_e2e by default): the T12 check needs designer1 to own no games, and
  // integration tests expect their database to hold no committed rows.
  const databaseUrl = e2eDatabaseUrl(process.env);
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: not a turbo task input
  const secret = process.env.GUEST_TOKEN_SECRET ?? "";
  // The API and the browser must agree on the issuer the tokens come from.
  const issuer = process.env.OIDC_ISSUER ?? "http://localhost:8080/realms/bgp";
  return [
    {
      command:
        "node --import tsx scripts/e2e-database.ts && node --import tsx apps/server/src/main.ts",
      url: "http://127.0.0.1:3000/api/healthz",
      reuseExistingServer,
      env: {
        E2E_DATABASE_URL: databaseUrl,
        DATABASE_URL: databaseUrl,
        HOST: "127.0.0.1",
        PORT: "3000",
        PUBLIC_WEB_ORIGIN: "http://localhost:5173",
        OIDC_ISSUER: issuer,
        OIDC_JWKS_URL: `${issuer}/protocol/openid-connect/certs`,
        GUEST_TOKEN_SECRET:
          Buffer.byteLength(secret) >= 32 ? secret : randomBytes(32).toString("base64"),
        BLOB_DRIVER: "fs",
        BLOB_FS_DIR: ".data/e2e-blobs",
        LOG_LEVEL: "warn",
      },
    },
    {
      command: "pnpm --filter @bgp/web dev",
      url: "http://localhost:5173/",
      reuseExistingServer,
      env: {
        VITE_API_URL: "http://localhost:3000",
        VITE_WS_URL: "ws://localhost:3000/ws",
        VITE_OIDC_ISSUER: issuer,
      },
    },
  ];
}

export default defineConfig({
  testDir: "./e2e",
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  timeout: 120_000,
  reporter: process.env.CI ? "github" : "list",
  expect: { timeout: 30_000 },
  use: { trace: "retain-on-failure" },
  webServer: [tableServer, ...appServers()],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
