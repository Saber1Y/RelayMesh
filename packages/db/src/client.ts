import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Db = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  close(): Promise<void>;
}

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

export function connectDb(url: string, options: { max?: number } = {}): DbHandle {
  if (!/^postgres(ql)?:\/\//.test(url)) throw new Error("Database URL must start with postgres:// or postgresql://");
  // numeric(78,0) and bigint columns are parsed by Drizzle's column modes, not by the driver.
  const client = postgres(url, { max: options.max ?? 10, onnotice: () => {} });
  return { db: drizzle(client, { schema }), close: () => client.end({ timeout: 5 }) };
}

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
