// Creates Better Auth's tables (user, session, account, verification) in sqlite.db.
import { getMigrations } from "better-auth/db/migration";
import { auth } from "../lib/auth.ts";

const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
await runMigrations();
console.log(
  "migrated. created:", toBeCreated.map((t) => t.table).join(", ") || "none",
  "| altered:", toBeAdded.map((t) => t.table).join(", ") || "none",
);
