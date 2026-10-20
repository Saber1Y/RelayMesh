import { connectDb } from "./client";
import { runMigrations } from "./migrate";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (see .env.example)");
  process.exit(1);
}

const { db, close } = connectDb(url, { max: 1 });
try {
  await runMigrations(db);
  console.log("Migrations applied");
} finally {
  await close();
}
