import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { migrateDatabase } from "../apps/server/src/db/migrate.js";

const envFile = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const url = process.env.DATABASE_URL ?? "postgres://bgp:bgp@localhost:5432/bgp";
try {
  await migrateDatabase(url);
  console.info("Database migrations applied.");
} catch {
  // Driver errors can contain credentials or query parameters. Keep CLI output bounded.
  console.error("Database migration failed. Check DATABASE_URL and PostgreSQL readiness.");
  process.exitCode = 1;
}
