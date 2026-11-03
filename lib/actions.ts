"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "./dal";
import { pool } from "./db";

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
		revalidatePath("/", "layout");
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
	revalidatePath("/", "layout");
}

/** Removes the chat from the list. The caller has already deleted its thread (DELETE /agent). */
export async function deleteChat(id: string) {
	const user = await requireUser();
	await pool.query("DELETE FROM chats WHERE id = $1 AND user_id = $2", [id, user.id]);
	revalidatePath("/", "layout");
	redirect("/agent");
}
