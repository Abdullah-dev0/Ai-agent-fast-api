// Run before `next dev` / deploy, never at request time.
// 1. Better Auth's tables (user, session, account, verification).
// 2. Our own SQL files in db/migrations, each applied once, in name order.
import { readdir, readFile } from "node:fs/promises";
import { getMigrations } from "better-auth/db/migration";
import { auth } from "../lib/auth.ts";
import { pool } from "../lib/db.ts";

const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
await runMigrations();
console.log(
  "better-auth. created:", toBeCreated.map((t) => t.table).join(", ") || "none",
  "| altered:", toBeAdded.map((t) => t.table).join(", ") || "none",
);

await pool.query(
  "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
);
const dir = new URL("../db/migrations/", import.meta.url);
const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
const { rows } = await pool.query<{ name: string }>("SELECT name FROM schema_migrations");
const applied = new Set(rows.map((r) => r.name));

for (const file of files.filter((f) => !applied.has(f))) {
  const client = await pool.connect();
  try {
    // One transaction per file: a failed migration leaves nothing half-applied.
    await client.query("BEGIN");
    await client.query(await readFile(new URL(file, dir), "utf8"));
    await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    await client.query("COMMIT");
    console.log("applied", file);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

await pool.end();
