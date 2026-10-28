import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./auth";

export type User = {
	id: string;
	name: string;
	email: string;
	image: string | null;
	createdAt: Date;
};

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
