# Agent server (Python)

A LangGraph agent that uses Gemini and four tools, served by FastAPI. The
Next.js app's `/agent-tanstack` page talks to it with TanStack's `useChat`.

## Run it

You need the Next.js app's `.env` (it has `GEMINI_API_KEY` and `DATABASE_URL`),
Postgres running (`docker compose up -d`) and the tables (`npm run migrate`),
both in the project root. Then start two processes:

```bash
cd agent-server
uv sync              # install the Python packages (first time only)
uv run main.py       # the API on http://127.0.0.1:8123 (queues runs, streams them)
uv run worker.py     # a worker (runs the agent); start more for more capacity
```

Then, in the project root, `npm run dev`, sign in and open **Agent (TanStack)**.

## The files

| File | What it does |
|---|---|
| `tools.py` | The tools: current time, weather (Open-Meteo), a safe calculator, and `delete_chat_history`, which needs the user's approval. |
| `agent.py` | The agent, built with LangGraph like its quickstart: ask Gemini, run the tools it asked for (pausing for approval when needed), loop until it answers. |
| `main.py` | The API. Never runs the agent: queues runs, streams their logs, returns history, stops and clears chats. |
| `worker.py` | The worker. Claims queued runs from Postgres and runs the agent for them. |
| `runs.py` | The job queue and reply log shared by both: Postgres tables, heartbeats, retries. |
| `history.py` | Turns a saved LangGraph thread into the `{ id, role, parts }` messages TanStack's `useChat` shows after a reload, reasoning included. |

## How one message travels

```
Browser ──POST /agent──> API ──queues──> agent_runs (Postgres) <──claims── Worker ──> LangGraph ──> Gemini + tools
   ^                      │                                                  │
   └──── streams the ─────┘ <──────── agent_run_events (Postgres) <─ saves ──┘
         saved events
```

**AG-UI** is the shared language: a standard list of streamed events ("run
started", "a piece of text", "tool called", "reasoning", "run finished").
`ag-ui-langgraph` turns LangGraph's output into those events, and TanStack's
`useChat` reads them.

## Replies as jobs (`runs.py`, `worker.py`)

The API only queues a run; a worker runs it and saves every event in Postgres,
numbered 1, 2, 3... The browser reads that log, following TanStack's protocol:

| Moment | What the browser sends | What the API does |
|---|---|---|
| Send | `POST /agent` | Queues the run and streams its log, each event tagged `id: 1`, `id: 2`, ... |
| Connection drops | The same POST again, with `Last-Event-ID: <last id>` | Continues the log after that id; nothing runs twice |
| Page reload | `GET /agent?threadId=` | Returns the history, `activeRun` while a reply is running, and any pending approval |
| Rejoin | `GET /agent?runId=...&offset=-1` | Replays the log from the start, then streams the rest live |

The tables, from `db/migrations/0003` and `0004` (applied with `npm run migrate`):

| Table | Holds |
|---|---|
| `agent_runs` | One row per reply: `status` (`queued` / `running` / `finished`), the request (`input`), `attempts`, `cancel_requested`, `heartbeat_at` |
| `agent_run_events` | Every event of a reply, numbered (`seq`), exactly as sent to the browser |

- **Workers** claim runs with `FOR UPDATE SKIP LOCKED`, so any number can poll
  at once without two taking the same run. Each runs up to 4 replies at once
  (`WORKER_CONCURRENCY`).
- **Worker crash:** a running reply refreshes its heartbeat every 2 s. When it
  has been silent for 30 s, a worker claims the run again and continues it
  from the last step LangGraph saved. The page keeps the cut-off part and then
  receives the retried reply. After 3 attempts the run is closed with an error.
  Stopping a worker with Ctrl+C hands its replies back the same way.
- **Stop** (`POST /agent/stop`) sets `cancel_requested`; a queued run is closed
  at once, a running one by its worker on its next heartbeat.
- **Limits:** a run may take 30 minutes (`AGENT_RUN_TIMEOUT_SECONDS`), each
  Gemini call 60 s with 2 retries, and 12 graph steps. Finished logs are
  deleted after an hour; the conversation itself stays in the checkpointer.

## Approvals (`interrupt()`)

`delete_chat_history` is listed in `NEEDS_APPROVAL` (`tools.py`). Before running
it, `run_tools` calls LangGraph's `interrupt()`:

1. The run pauses and ends with `RUN_FINISHED` outcome `interrupt`, carrying the
   question ("Delete this whole conversation?").
2. The page shows Approve / Deny. TanStack lists interrupts from a non-TanStack
   server as `unbound` (shown, but without its own `resolveInterrupt`), so the
   page answers with `useChat`'s `resumeInterruptsUnsafe`: it sends the AG-UI
   `resume` field and streams the continued reply into the same chat.
3. LangGraph re-runs the node and `interrupt()` returns `{ approved }`. Deny:
   the agent is told it was cancelled. Approve: the thread is deleted once the
   reply ends, and the page clears the screen.

A pending approval is saved by the checkpointer, so after a reload
`GET /agent?threadId=` returns it and the buttons come back.

## Reasoning

`include_thoughts=True` (`agent.py`) makes Gemini return summaries of its
reasoning. The adapter streams them as `REASONING_*` events, TanStack shows them
as `thinking` parts, and the checkpointer saves them as `{"type": "thinking"}`
blocks that `history.py` turns back into `thinking` parts after a reload.

The adapter ends every run with a `MESSAGES_SNAPSHOT` that leaves the reasoning
out, and TanStack replaces its messages with it, so the worker drops that one
event. The streamed ids match the snapshot's, so nothing else changes.

## The agent, step by step (`agent.py`)

```
START -> call_model -> (asked for tools?) -> run_tools -> back to call_model
                    -> (plain answer)     -> END
```

1. `call_model` sends the conversation to Gemini, with the tools it may use.
2. If Gemini asks for tools, `run_tools` runs them (after approval where
   needed) and adds the results to the conversation.
3. Back to `call_model`: Gemini reads the results and either asks for more
   tools or writes the answer.

Tool results are saved with the id TanStack gives them (`tool-<call id>`), so
when `useChat` sends the history back the ids match and nothing is saved twice.
Each user has one thread, `tanstack:<user id>`.

## Things to know before using this for real

- **The Python server has no login.** It listens on `127.0.0.1` only. Anyone
  who can reach it could read, run or delete any thread by guessing its id.
  Before deploying, add auth to FastAPI and decide threads there.
- **A retried run starts its model call again**, so a reply cut off by a crash
  is written a second time (the page shows both). Approvals interrupted by a
  crash are re-asked by the retried run.
- **Gemini free tier is slow and limited.** Replies can take 10 to 20 seconds
  to start, and you can hit 429/503 errors.
- **Windows:** both processes run on a `SelectorEventLoop`, because the
  Postgres driver (psycopg) cannot run on Windows' default event loop.

## Sources

- LangGraph: install, quickstart (Graph API), add memory (Postgres checkpointer), `interrupt()` at docs.langchain.com
- Gemini in LangChain: `langchain-google-genai` (`include_thoughts`; reads `GOOGLE_API_KEY`, then `GEMINI_API_KEY`)
- `ag-ui-langgraph` and `ag-ui` (interrupts, `RunAgentInput.resume`) in `.venv`
- TanStack AI: `useChat` interrupts, `resumeInterruptsUnsafe`, thinking parts, in `node_modules/@tanstack`
