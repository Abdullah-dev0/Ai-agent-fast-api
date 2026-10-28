import { Pool } from "pg";

// One pool per process. In dev, Next re-evaluates modules on every edit, so the
// pool is parked on globalThis; otherwise each reload would open new connections.
const globalForDb = globalThis as unknown as { pool?: Pool };

export const pool = globalForDb.pool ?? new Pool({ connectionString: process.env.DATABASE_URL });

if (process.env.NODE_ENV !== "production") globalForDb.pool = pool;
