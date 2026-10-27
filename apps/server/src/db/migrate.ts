import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "./connection.js";

// Works from src/db and dist/db; independent of the caller's working directory.
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle/", import.meta.url));

export async function migrateDatabase(url: string): Promise<void> {
  const connection = connectDatabase(url);
  try {
    // Serialize migration startup across worktrees and test processes.
    // connectDatabase uses one session; closing it also releases this advisory lock.
    await connection.client`SELECT pg_advisory_lock(72107, 1)`;
    await migrate(connection.db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await connection.close();
  }
}
