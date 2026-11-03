"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { useUser } from "./user-provider";

export function UserMenu() {
  const user = useUser();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on a click outside or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!user) return null;

  async function signOut() {
    await authClient.signOut();
    router.push("/");
    router.refresh();
  }

  return (
    <div ref={ref} className="relative">
      {open && (
        <div
          role="menu"
          className="absolute right-0 bottom-full left-0 mb-2 overflow-hidden rounded-xl border border-line bg-background p-1.5 text-sm shadow-lg">
          <p className="truncate px-3 py-2 text-muted">{user.email}</p>
          <button
            role="menuitem"
            onClick={signOut}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-hover">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
            </svg>
            Sign out
          </button>
        </div>
      )}
      <button
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm hover:bg-hover">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-sm font-medium text-background">
          {user.name.charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{user.name}</span>
      </button>
    </div>
  );
}

export function UserMenuSkeleton() {
  return <div className="h-12 animate-pulse rounded-lg bg-surface" />;
}
