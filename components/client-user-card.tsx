"use client";

import { useUser } from "./user-provider";

// A client component, several levels below the layout, that needs the user.
// No props, no fetch: it reads the promise the layout put in context.
export function ClientUserCard() {
  const user = useUser();
  if (!user) return null;
  return (
    <dl className="grid grid-cols-[6rem_1fr] gap-y-3 text-sm sm:grid-cols-[8rem_1fr]">
      <dt className="text-muted">Name</dt>
      <dd>{user.name}</dd>
      <dt className="text-muted">Email</dt>
      <dd className="break-all">{user.email}</dd>
      <dt className="text-muted">User ID</dt>
      <dd className="font-mono text-xs break-all">{user.id}</dd>
    </dl>
  );
}
