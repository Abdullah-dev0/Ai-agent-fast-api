# User cache demo

Next.js 16 (App Router) + Better Auth + SQLite. A test bed for one question:
how do you fetch the current user once and use it everywhere?

## Run it

```bash
npm install
cp .env.example .env        # then set BETTER_AUTH_SECRET (openssl rand -base64 32)
npm run migrate             # creates sqlite.db with Better Auth's tables
npm run dev                 # http://localhost:3000
```

## Where to look

| File | What it shows |
|---|---|
| `lib/dal.ts` | `getUser()` wrapped in React `cache()`; `requireUser()` for protected pages |
| `app/(app)/layout.tsx` | Calls `getUser()` without `await`, hands the promise to `UserProvider` |
| `components/user-provider.tsx` | `useUser()` reads that promise with `use()` in client components |
| `app/(app)/dashboard/page.tsx` | Server components calling `getUser()` three times in one request |
| `app/(app)/profile/page.tsx` + `lib/actions.ts` | Edit the name; `revalidatePath` refreshes the layout's user |
| `app/(app)/settings/page.tsx` | A client component showing the user with no props and no fetch |
| `app/(marketing)/page.tsx` | No user access, so it stays static |
| `proxy.ts` | Cookie-presence redirect only; no DB lookup |

## Things to try

1. Sign up, open `/dashboard`, and count `[getUser]` lines in the terminal.
2. Set `cacheComponents: false` in `next.config.ts`, rebuild, and count again.
3. Change your name on `/profile` and watch the header update without a reload.
4. Sign out and open `/profile` directly: `proxy.ts` redirects you.
5. Run `npm run build` and compare the route symbols for `/` and `/dashboard`.
