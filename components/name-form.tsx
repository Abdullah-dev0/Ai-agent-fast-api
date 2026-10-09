"use client";

import { useActionState } from "react";
import { updateName, type ActionState } from "@/lib/actions";

export function NameForm({ currentName }: { currentName: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(updateName, null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <label className="flex-1 text-sm">
        <span className="mb-1 block text-zinc-500">Display name</span>
        <input
          name="name"
          defaultValue={currentName}
          required
          className="w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700"
        />
      </label>
      <button
        disabled={pending}
        className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
      >
        {pending ? "Saving..." : "Save"}
      </button>
      {state && (
        <p className={`w-full text-sm ${state.ok ? "text-green-600" : "text-red-600"}`}>
          {state.message}
        </p>
      )}
    </form>
  );
}
