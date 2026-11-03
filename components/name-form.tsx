"use client";

import { useActionState } from "react";
import { updateName, type ActionState } from "@/lib/actions";
import { buttonPrimary, field } from "@/lib/ui";

export function NameForm({ currentName }: { currentName: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(updateName, null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <label className="min-w-48 flex-1 text-sm">
        <span className="mb-1.5 block text-muted">Display name</span>
        <input name="name" defaultValue={currentName} required className={field} />
      </label>
      <button disabled={pending} className={`${buttonPrimary} text-sm`}>
        {pending ? "Saving..." : "Save"}
      </button>
      {state && (
        <p className={`w-full text-sm ${state.ok ? "text-success" : "text-danger"}`}>
          {state.message}
        </p>
      )}
    </form>
  );
}
