# Aragon

A ChatGPT-style chat app. Next.js 16 (App Router) + Better Auth + Postgres for the
web app, and a Python LangGraph agent (Gemini, with tools) streamed to the AI SDK's `useChat`.

## Run it

```bash
npm install
cp .env.example .env        # set BETTER_AUTH_SECRET (openssl rand -base64 32) and GEMINI_API_KEY
docker compose up -d --wait # Postgres on 127.0.0.1:5434
npm run migrate             # Better Auth tables + db/migrations/*.sql
npm run dev                 # http://localhost:3000 (starts the agent server too)
```

## Where to look

| File | What it does |
|---|---|
| `app/(app)/layout.tsx` + `components/sidebar.tsx` | The shell: new chat, chat list, usage link, user menu |
| `app/(app)/agent/[id]/page.tsx` | One chat; the page checks it is yours (`chats.id` is the agent's thread id) |
| `components/agent-chat.tsx` | The chat UI: markdown replies, approvals, tool calls, composer |
| `lib/use-agent-chat.ts` | The AI SDK's `useChat`, plus the saved chat, context meter and approvals |
| `lib/chat-types.ts` | The chat's shared types (messages, parts, approvals, thinking levels) |
| `app/(app)/usage/page.tsx` + `lib/dal.ts` | Token usage over 30 days, from the `token_usage` table |
| `lib/actions.ts` | Server actions: new chat, rename-on-first-message, delete chat |
| `proxy.ts` | Cookie-presence redirect to sign-in; the real check is `requireUser()` |
| `db/schema.sql` | Every table as it is in the database. Generated: after a migration, run `npm run db:schema` |

## Python agent (agent-server/)

A LangGraph agent with Gemini and tools, served by FastAPI, used by the
`/agent` page through our own `useAgentChat` hook. See
[agent-server/README.md](agent-server/README.md) for how it works and how to run it.
