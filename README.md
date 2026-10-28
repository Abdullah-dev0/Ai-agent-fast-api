# User cache demo

Next.js 16 (App Router) + Better Auth + Postgres. A test bed for one question:
how do you fetch the current user once and use it everywhere?

## Run it

```bash
npm install
cp .env.example .env        # set BETTER_AUTH_SECRET (openssl rand -base64 32) and GEMINI_API_KEY
docker compose up -d --wait # Postgres on 127.0.0.1:5434
npm run migrate             # Better Auth tables + db/migrations/*.sql
npm run dev                 # http://localhost:3000
```

## Chat that survives a reload

`/chat` uses TanStack AI with Google Gemini (`gemini-3.5-flash`). On every turn,
`withPersistence` saves the whole transcript to the `chat_threads` table, and on
mount `useChat({ persistence: true })` reloads it with `GET /api/chat?threadId=`.

| File | What it does |
|---|---|
| `lib/chat-persistence.ts` | Message store against Postgres (load = `[]` if missing, save = full overwrite) |
| `app/api/chat/route.ts` | `POST` streams the reply, `GET` hydrates; both check the thread belongs to the user |
| `components/chat.tsx` | `useChat` with server-side persistence, nothing kept in the browser |
| `db/migrations/` | Versioned SQL, applied by `npm run migrate`, never at request time |

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

## Python agent (agent-server/)

A LangGraph agent with Gemini and tools, served by FastAPI, used by the `/agent`
(CopilotKit) and `/agent-tanstack` (TanStack useChat) pages. See
[agent-server/README.md](agent-server/README.md) for how it works and how to run it.
