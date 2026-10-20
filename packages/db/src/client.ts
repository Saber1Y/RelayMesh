import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  close(): Promise<void>;
}

export function connectDb(url: string, options: { max?: number } = {}): DbHandle {
  if (!/^postgres(ql)?:\/\//.test(url)) throw new Error("Database URL must start with postgres:// or postgresql://");
  // numeric(78,0) and bigint columns are parsed by Drizzle's column modes, not by the driver.
  const client = postgres(url, { max: options.max ?? 10, onnotice: () => {} });
  return { db: drizzle(client, { schema }), close: () => client.end({ timeout: 5 }) };
}
