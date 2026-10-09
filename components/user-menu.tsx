"use client";

import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { useUser } from "./user-provider";

export function UserMenu() {
  const user = useUser();
  const router = useRouter();
  if (!user) return null;

  async function signOut() {
    await authClient.signOut();
    router.push("/");
    router.refresh();
  }

  return (
    <div className="flex items-center gap-3">
      <span className="grid size-8 place-items-center rounded-full bg-zinc-900 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
        {user.name.charAt(0).toUpperCase()}
      </span>
      <span className="hidden text-sm sm:block">{user.name}</span>
      <button
        onClick={signOut}
        className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
      >
        Sign out
      </button>
    </div>
  );
}

export function UserMenuSkeleton() {
  return <div className="h-8 w-40 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-800" />;
}
