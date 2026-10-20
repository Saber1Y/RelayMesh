// Resets the test database schema and applies migrations once per `pnpm test:db` run.
import postgres from "postgres";
import { connectDb, runMigrations } from "../src/client.js";

export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("TEST_DATABASE_URL is not set. Start Postgres with `pnpm db:up` and copy .env.example to .env.");
  }
  if (!/\/relaymesh_test(\?|$)/.test(url)) {
    throw new Error("Refusing to reset a database that is not named relaymesh_test");
  }

  const admin = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;");
    await admin.unsafe("DROP FUNCTION IF EXISTS relaymesh_reject_mutation, relaymesh_guard_intent_update CASCADE;");
  } finally {
    await admin.end();
  }

  const { db, close } = connectDb(url, { max: 1 });
  try {
    await runMigrations(db);
  } finally {
    await close();
  }
}
