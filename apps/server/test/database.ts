import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export function testDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.TEST_DATABASE_URL ?? "postgres://bgp:bgp@localhost:5432/bgp_test";
  const url = new URL(value);
  const development = new URL(env.DATABASE_URL ?? "postgres://bgp:bgp@localhost:5432/bgp");
  const sameDatabase =
    url.hostname === development.hostname &&
    (url.port || "5432") === (development.port || "5432") &&
    url.pathname === development.pathname;
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.pathname.endsWith("_test") ||
    sameDatabase
  ) {
    throw new Error("TEST_DATABASE_URL must name a separate PostgreSQL database ending in _test.");
  }
  return value;
}
