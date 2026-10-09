"use client";

import { useUser } from "./user-provider";

// A client component, several levels below the layout, that needs the user.
// No props, no fetch: it reads the promise the layout put in context.
export function ClientUserCard() {
  const user = useUser();
  if (!user) return null;
  return (
    <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
      <dt className="text-zinc-500">Name</dt>
      <dd>{user.name}</dd>
      <dt className="text-zinc-500">Email</dt>
      <dd>{user.email}</dd>
      <dt className="text-zinc-500">User ID</dt>
      <dd className="font-mono text-xs break-all">{user.id}</dd>
    </dl>
  );
}
