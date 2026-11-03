import type { PgDatabase } from "drizzle-orm/pg-core";
import { drizzle, type PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

// Each owner closes its connection (including failed migrations and tests).
export function connectDatabase(url: string, options: { max?: number } = {}) {
  const client = postgres(url, {
    max: options.max ?? 1,
    connect_timeout: 5,
    onnotice: () => {},
  });
  return { db: drizzle(client, { schema }), client, close: () => client.end({ timeout: 5 }) };
}
export type DatabaseConnection = ReturnType<typeof connectDatabase>;

/** A connection or a transaction; nested transactions become savepoints. */
export type Database = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;
