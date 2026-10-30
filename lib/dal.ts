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
 * The single entry point for "who is the current user?".
 *
 * cache() memoizes per request: the layout, the page and any nested server
 * component can all call getUser() and only one session lookup runs.
 * Nothing is shared between requests, so there is nothing to invalidate
 * and no way to leak one user's data to another.
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
