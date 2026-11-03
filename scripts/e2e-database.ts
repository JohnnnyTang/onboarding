import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_DATABASE_URL = "postgres://bgp:bgp@localhost:5432/bgp";

/**
 * The database the end-to-end API server uses: E2E_DATABASE_URL, or a `bgp_e2e` database on
 * the same server as DATABASE_URL. It is neither the development database (whose games would
 * break "designer1 sees an empty games list") nor the integration test database (whose tests
 * expect no committed rows). The name must end in `_e2e` so neither can be chosen by mistake.
 */
export function e2eDatabaseUrl(env: NodeJS.ProcessEnv): string {
  let url: URL;
  if (env.E2E_DATABASE_URL) {
    url = new URL(env.E2E_DATABASE_URL);
  } else {
    url = new URL(env.DATABASE_URL || DEFAULT_DATABASE_URL);
    url.pathname = "/bgp_e2e";
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !/^\/[a-z0-9_]+_e2e$/.test(url.pathname)
  ) {
    throw new Error("E2E_DATABASE_URL must name a PostgreSQL database ending in _e2e.");
  }
  return url.href;
}

/** Creates the end-to-end database if it is missing, then applies the migrations. */
async function prepare(): Promise<void> {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const envFile = resolve(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const target = new URL(e2eDatabaseUrl(process.env));
  const name = target.pathname.slice(1);
  const maintenance = new URL(target);
  maintenance.pathname = "/postgres";
  // Server code is loaded only when preparing, never when the Playwright config imports this.
  const { connectDatabase } = await import("../apps/server/src/db/connection.js");
  const { migrateDatabase } = await import("../apps/server/src/db/migrate.js");
  const admin = connectDatabase(maintenance.href);
  try {
    const existing = await admin.client`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (existing.length === 0) await admin.client.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.close();
  }
  await migrateDatabase(target.href);
  console.info(`End-to-end database ${name} is ready.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await prepare();
  } catch {
    // Driver errors can contain credentials. Keep the output bounded, like db-migrate.ts.
    console.error("End-to-end database setup failed. Check DATABASE_URL and PostgreSQL readiness.");
    process.exitCode = 1;
  }
}
