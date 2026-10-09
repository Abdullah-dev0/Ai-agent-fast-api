import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { DatabaseSync } from "node:sqlite";

export const auth = betterAuth({
	database: new DatabaseSync("./sqlite.db"),
	emailAndPassword: { enabled: true },
	plugins: [nextCookies()],
});
