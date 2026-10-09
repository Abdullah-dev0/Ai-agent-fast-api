"use client";

import { createContext, use, useContext } from "react";
import type { User } from "@/lib/dal";

const UserContext = createContext<Promise<User | null> | null>(null);

export function UserProvider({
  userPromise,
  children,
}: {
  userPromise: Promise<User | null>;
  children: React.ReactNode;
}) {
  return <UserContext value={userPromise}>{children}</UserContext>;
}

/**
 * Read the current user in any client component under the (app) layout.
 * It suspends until the promise resolves, so the caller needs a <Suspense>
 * boundary above it. No fetch happens here: the server already started it.
 */
export function useUser(): User | null {
  const promise = useContext(UserContext);
  if (!promise) throw new Error("useUser must be used inside <UserProvider>");
  return use(promise);
}
