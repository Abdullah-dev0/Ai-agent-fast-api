# Agent server (Python)

A LangGraph agent that uses Gemini and three tools, served by FastAPI. The
Next.js app's `/agent-tanstack` page talks to it with TanStack's `useChat`.

## Run it

You need the Next.js app's `.env` (it has `GEMINI_API_KEY` and `DATABASE_URL`)
and Postgres running (`docker compose up -d` in the project root).

```bash
cd agent-server
uv sync              # install the Python packages (first time only)
uv run main.py       # agent on http://127.0.0.1:8123
```

Then, in the project root, `npm run dev`, sign in and open **Agent (TanStack)**
in the top menu.

## The files

| File | What it does |
|---|---|
| `tools.py` | Three plain Python functions the model can call: the current time, the weather (Open-Meteo, no key needed) and a safe calculator. |
| `agent.py` | The agent, built with LangGraph like its quickstart: ask Gemini, run any tools it asked for, loop until it answers. |
| `main.py` | FastAPI. Connects to Postgres, builds the agent, and exposes it at `POST /agent`, plus `GET /agent?threadId=` for the saved chat. |
| `history.py` | Turns a saved LangGraph thread into the `{ id, role, parts }` messages TanStack's `useChat` shows after a reload. |
| `runs.py` | Replies that survive a refresh: runs the agent in the background and keeps a numbered log of its events, so a reloaded page can rejoin. |

## Refreshing in the middle of a reply (`runs.py`)

Written by hand to follow the protocol TanStack's `useChat` speaks:

| Moment | What the browser sends | What `main.py` does |
|---|---|---|
| Send | `POST /agent` | Starts the agent in a background task and streams its log, each event tagged `id: 1`, `id: 2`, ... |
| Connection drops | The same POST again, with `Last-Event-ID: <last id>` | Does **not** run the agent again; continues the log after that id |
| Page reload | `GET /agent?threadId=` | Returns the history **and** `activeRun: { runId }` while a reply is running |
| Rejoin | `GET /agent?runId=...&offset=-1` | Replays the log from the start, then streams the rest live |

The agent no longer runs inside the HTTP response, so closing the tab does not
stop it; the reply finishes and is saved either way. Logs live in this
process's memory and are dropped 60 seconds after a run ends, so a server
restart in the middle of a reply loses that reply (the finished ones are in
Postgres). `ag-ui-langgraph`'s own `add_langgraph_fastapi_endpoint` is no longer
used, because it runs the agent inside the response.

## How one message travels

```
Browser ──> FastAPI POST /agent ──> LangGraph agent ──> Gemini
  (TanStack page,  (streams AG-UI events back)   └──> tools
   no Next.js route)
```

**AG-UI** is the shared language: a standard list of streamed events ("run
started", "a piece of text", "tool called", "run finished"). `ag-ui-langgraph`
turns LangGraph's output into those events, and TanStack's `useChat` reads
them. Any other AG-UI client could use the same server.

## The agent, step by step (`agent.py`)

```
START -> call_model -> (asked for tools?) -> run_tools -> back to call_model
                    -> (plain answer)     -> END
```

1. `call_model` sends the conversation to Gemini, with the tools it may use.
2. If Gemini replies "call `get_weather` with city=Lahore", `should_continue`
   routes to `run_tools`, which runs it and adds the result to the conversation.
3. Back to `call_model`: Gemini reads the result and either asks for more
   tools or writes the answer.

## Where chats are saved

| What | Where | Survives |
|---|---|---|
| The agent's memory of a conversation | Postgres, in LangGraph's own tables (`checkpoints`, `checkpoint_writes`, `checkpoint_blobs`, `checkpoint_migrations`), created by `checkpointer.setup()` | Everything: reloads and restarts |
| The chat shown on the TanStack page | Loaded from the agent's Postgres memory (`GET /agent?threadId=`, `persistence: true`) | Everything: reloads and restarts |

Each user has one thread, `tanstack:<user id>`.

The TanStack page loads its chat from the agent on every page load (`history.py`).
Tool results are saved with the id TanStack gives them (`tool-<call id>`, see
`run_tools` in `agent.py`). When `useChat` sends the history back, the ids match
and the adapter skips them instead of saving them twice.

Separately, Next.js keeps a page you navigate away from alive in the background
(`cacheComponents` uses React `<Activity>`), so going back through the menu shows
the page exactly as you left it, even before any reload.

## Things to know before using this for real

- **The Python server has no login.** It listens on `127.0.0.1` only, so only
  your machine can reach it. Anyone who can reach it could read any thread by
  guessing its id. The TanStack page calls Python directly from the
  browser, with no Next.js route checking the login. Before deploying, add auth to FastAPI (check the
  session or a token) and decide threads there.
- **Gemini free tier is slow and limited.** Replies can take 10 to 20 seconds
  to start, and you can hit 429/503 errors.
- **Windows:** `main.py` starts uvicorn on a `SelectorEventLoop`, because the
  Postgres driver (psycopg) cannot run on Windows' default event loop.
- `ag-ui-langgraph`'s README passes the graph straight to
  `add_langgraph_fastapi_endpoint`; the code needs it wrapped in
  `LangGraphAgent(name=..., graph=...)`. `main.py` no longer uses that helper
  (see `runs.py`), but still runs the agent through `LangGraphAgent`.

## Sources

- LangGraph: install, quickstart (Graph API), add memory (Postgres checkpointer) at docs.langchain.com
- Gemini in LangChain: `langchain-google-genai` (reads `GOOGLE_API_KEY`, then `GEMINI_API_KEY`)
- `ag-ui-langgraph` on PyPI and its source in `.venv`
