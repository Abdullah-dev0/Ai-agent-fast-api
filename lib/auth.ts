import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
// The .ts extension lets `npm run migrate` (plain Node) import this file too.
import { pool } from "./db.ts";

export const auth = betterAuth({
	database: pool,
	emailAndPassword: { enabled: true },
	plugins: [nextCookies()],
});
