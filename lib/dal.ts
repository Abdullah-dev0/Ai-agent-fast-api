import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./auth";
import { pool } from "./db";
import { estimateCost, sumCosts } from "./usage";

type User = {
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
const getUser = cache(async (): Promise<User | null> => {
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

type UsageDay = { day: string; input: number; output: number };
// cost is null when the model's price is not in lib/usage.ts.
type UsageModel = {
	provider: string;
	model: string;
	calls: number;
	input: number;
	output: number;
	cost: number | null;
};
type Usage = {
	totals: { calls: number; input: number; output: number };
	/** Estimated dollars. `unpriced`: some model had no known price, so the total is a lower bound. */
	cost: { total: number; unpriced: boolean };
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
	const models: UsageModel[] = perModel.rows.map((m) => ({
		...m,
		cost: estimateCost(m.provider, m.model, m.input, m.output),
	}));
	return {
		totals: totals.rows[0],
		cost: sumCosts(models.map((m) => m.cost)),
		days: perDay.rows,
		models,
	};
}

type ChatUsage = {
	id: string;
	title: string | null;
	/** False when the chat was deleted: its usage rows stay. */
	exists: boolean;
	tokens: number;
	cost: number | null;
};

/** The chats that used the most tokens over the last `days` days. */
export async function getTopChats(userId: string, days = 30, limit = 5): Promise<ChatUsage[]> {
	const { rows } = await pool.query(
		// One row per chat and model, because the price depends on the model.
		`SELECT t.thread_id AS id, c.title, (c.id IS NOT NULL) AS exists, t.provider, t.model,
		        sum(t.input_tokens)::float8 AS input, sum(t.output_tokens)::float8 AS output
		 FROM token_usage t
		 LEFT JOIN chats c ON c.id = t.thread_id AND c.user_id = t.user_id
		 WHERE t.user_id = $1 AND t.created_at >= now() - make_interval(days => $2)
		 GROUP BY t.thread_id, c.id, c.title, t.provider, t.model`,
		[userId, days],
	);
	// costs: one entry per model the chat used, folded into ChatUsage.cost below.
	const byChat = new Map<string, ChatUsage & { costs: (number | null)[] }>();
	for (const r of rows) {
		const chat = byChat.get(r.id) ?? {
			id: r.id,
			title: r.title,
			exists: r.exists,
			tokens: 0,
			cost: 0,
			costs: [] as (number | null)[],
		};
		chat.tokens += r.input + r.output;
		chat.costs.push(estimateCost(r.provider, r.model, r.input, r.output));
		byChat.set(r.id, chat);
	}
	return [...byChat.values()]
		.map(({ costs, ...chat }) => {
			const { total, unpriced } = sumCosts(costs);
			return { ...chat, cost: unpriced ? null : total };
		})
		.sort((a, b) => b.tokens - a.tokens)
		.slice(0, limit);
}

/** Tokens used this calendar month (UTC) and the user's monthly limit; null limit means none. */
export async function getBudget(userId: string): Promise<{ used: number; limit: number | null }> {
	const { rows } = await pool.query<{ used: number; limit: number | null }>(
		`SELECT
		   (SELECT coalesce(sum(input_tokens + output_tokens), 0)::float8 FROM token_usage
		     WHERE user_id = $1 AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS used,
		   (SELECT monthly_token_limit::float8 FROM usage_budgets WHERE user_id = $1) AS "limit"`,
		[userId],
	);
	return rows[0];
}
