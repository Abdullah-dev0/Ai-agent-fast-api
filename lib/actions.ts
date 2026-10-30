"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "./auth";
import { requireUser } from "./dal";
import { pool } from "./db";

export type ActionState = { ok: boolean; message: string } | null;

export async function updateName(_prev: ActionState, formData: FormData): Promise<ActionState> {
	// Server actions are public endpoints: check auth here, not just in the page.
	await requireUser();

	const name = String(formData.get("name") ?? "").trim();
	if (name.length < 2) return { ok: false, message: "Name must be at least 2 characters." };

	await auth.api.updateUser({ body: { name }, headers: await headers() });

	// Layouts do not re-render on navigation, so the provider would keep the
	// old user. This re-runs the (app) layout and pushes the fresh user down.
	revalidatePath("/", "layout");
	return { ok: true, message: "Saved." };
}

export async function newChat() {
	const user = await requireUser();
	// A chat with no title has no messages: reuse it, so clicking New chat again
	// does not pile up empty rows.
	const { rows } = await pool.query<{ id: string }>("SELECT id FROM chats WHERE user_id = $1 AND title IS NULL", [
		user.id,
	]);
	let id = rows[0]?.id;
	if (!id) {
		id = crypto.randomUUID();
		await pool.query("INSERT INTO chats (id, user_id) VALUES ($1, $2)", [id, user.id]);
		revalidatePath("/agent", "layout");
	}
	redirect(`/agent/${id}`);
}

/** A message was sent: move the chat to the top. The first message names it. */
export async function touchChat(id: string, text: string) {
	const user = await requireUser();
	await pool.query(
		"UPDATE chats SET title = COALESCE(title, $1), updated_at = now() WHERE id = $2 AND user_id = $3",
		[text.slice(0, 60), id, user.id],
	);
	revalidatePath("/agent", "layout");
}

/** Removes the chat from the list. The caller has already deleted its thread (DELETE /agent). */
export async function deleteChat(id: string) {
	const user = await requireUser();
	await pool.query("DELETE FROM chats WHERE id = $1 AND user_id = $2", [id, user.id]);
	revalidatePath("/agent", "layout");
	redirect("/agent");
}
