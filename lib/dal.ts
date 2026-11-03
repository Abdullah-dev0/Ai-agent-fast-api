import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./auth";
import { pool } from "./db";

export type User = {
	id: string;
	name: string;
	email: string;
	image: string | null;
	createdAt: Date;
};

// A null title means nothing has been sent in the chat yet.
export type Chat = { id: string; title: string | null };

/**
 * The single entry point for "who is the current user?". cache() shares one
 * session lookup per request between everything that calls it.
 */
export const getUser = cache(async (): Promise<User | null> => {
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session) return null;
	const { id, name, email, image, createdAt } = session.user;
	return { id, name, email, image: image ?? null, createdAt };
});

/** For pages and actions that must be signed in. This is the real auth check. */
export async function requireUser(): Promise<User> {
	const user = await getUser();
	if (!user) redirect("/sign-in");
	return user;
}

/** The user's chats, most recently used first. */
export async function listChats(userId: string): Promise<Chat[]> {
	const { rows } = await pool.query<Chat>(
		"SELECT id, title FROM chats WHERE user_id = $1 ORDER BY updated_at DESC",
		[userId],
	);
	return rows;
}

/** Null when the chat does not exist or belongs to someone else. */
export async function getChat(id: string, userId: string): Promise<Chat | null> {
	const { rows } = await pool.query<Chat>("SELECT id, title FROM chats WHERE id = $1 AND user_id = $2", [id, userId]);
	return rows[0] ?? null;
}

export type UsageDay = { day: string; input: number; output: number };
export type UsageModel = { provider: string; model: string; calls: number; input: number; output: number };
export type Usage = {
	totals: { calls: number; input: number; output: number };
	days: UsageDay[];
	models: UsageModel[];
};

/** Tokens the user's replies used over the last `days` days, from the rows the agent server writes. */
export async function getUsage(userId: string, days = 30): Promise<Usage> {
	const since = `now() - make_interval(days => $2)`;
	const [totals, perDay, perModel] = await Promise.all([
		pool.query(
			`SELECT count(*)::int AS calls, coalesce(sum(input_tokens), 0)::float8 AS input, coalesce(sum(output_tokens), 0)::float8 AS output
			 FROM token_usage WHERE user_id = $1 AND created_at >= ${since}`,
			[userId, days],
		),
		// Every day in the range, so quiet days show as empty bars.
		pool.query(
			`SELECT to_char(d, 'YYYY-MM-DD') AS day, coalesce(sum(t.input_tokens), 0)::float8 AS input, coalesce(sum(t.output_tokens), 0)::float8 AS output
			 FROM generate_series(current_date - ($2::int - 1), current_date, interval '1 day') AS d
			 LEFT JOIN token_usage t ON t.user_id = $1 AND t.created_at::date = d::date
			 GROUP BY d ORDER BY d`,
			[userId, days],
		),
		pool.query(
			`SELECT provider, model, count(*)::int AS calls, sum(input_tokens)::float8 AS input, sum(output_tokens)::float8 AS output
			 FROM token_usage WHERE user_id = $1 AND created_at >= ${since}
			 GROUP BY provider, model ORDER BY sum(input_tokens + output_tokens) DESC`,
			[userId, days],
		),
	]);
	return { totals: totals.rows[0], days: perDay.rows, models: perModel.rows };
}
