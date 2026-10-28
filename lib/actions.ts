"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { auth } from "./auth";
import { deleteThread, threadIdFor } from "./chat-persistence";
import { requireUser } from "./dal";

export type ActionState = { ok: boolean; message: string } | null;

export async function updateName(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
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

/** Delete the signed-in user's chat. The thread id comes from the session, never the client. */
export async function deleteChat(): Promise<void> {
  const user = await requireUser();
  await deleteThread(threadIdFor(user.id));
}
