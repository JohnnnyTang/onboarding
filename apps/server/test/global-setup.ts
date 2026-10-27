import { migrateDatabase } from "../src/db/migrate.js";
import { testDatabaseUrl } from "./database.js";

export default async function setup(): Promise<void> {
  try {
    await migrateDatabase(testDatabaseUrl());
  } catch {
    throw new Error(
      "Test database setup failed. Start Docker services with --wait and check TEST_DATABASE_URL (a separate _test database). Integration tests never skip an unavailable database.",
    );
  }
}
