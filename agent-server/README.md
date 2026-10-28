# Agent server (Python)

A LangGraph agent that uses Gemini and three tools, served by FastAPI. The
Next.js app talks to it from two pages, so you can compare two ways of building
the chat screen.

## Run it

You need the Next.js app's `.env` (it has `GEMINI_API_KEY` and `DATABASE_URL`)
and Postgres running (`docker compose up -d` in the project root).

```bash
cd agent-server
uv sync              # install the Python packages (first time only)
uv run main.py       # agent on http://127.0.0.1:8123
```

Then, in the project root, `npm run dev`, sign in and open **Agent** or
**Agent (TanStack)** in the top menu.

## The three files

| File | What it does |
|---|---|
| `tools.py` | Three plain Python functions the model can call: the current time, the weather (Open-Meteo, no key needed) and a safe calculator. |
| `agent.py` | The agent, built with LangGraph like its quickstart: ask Gemini, run any tools it asked for, loop until it answers. |
| `main.py` | FastAPI. Connects to Postgres, builds the agent, and exposes it at `POST /agent`, plus `GET /agent?threadId=` for the saved chat. |
| `history.py` | Turns a saved LangGraph thread into the `{ id, role, parts }` messages TanStack's `useChat` shows after a reload. |

## How one message travels

```
Browser ──> Next.js /api/copilotkit ──> FastAPI POST /agent ──> LangGraph agent ──> Gemini
  (CopilotKit page)                       (streams AG-UI events back)        └──> tools

Browser ─────────────────────────────> FastAPI POST /agent   (TanStack page, no Next.js route)
```

**AG-UI** is the shared language: a standard list of streamed events ("run
started", "a piece of text", "tool called", "run finished"). `ag-ui-langgraph`
turns LangGraph's output into those events, and both CopilotKit and TanStack's
`useChat` read them. That is why one Python server works with both pages.

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
| The chat shown on the CopilotKit page | Next.js memory (`InMemoryAgentRunner`) | Page reloads, **not** a Next.js restart |
| The chat shown on the TanStack page | Loaded from the agent's Postgres memory (`GET /agent?threadId=`, `persistence: true`) | Everything: reloads and restarts |

So after a restart the screen can be empty while the agent still remembers
(ask it "what did I ask you earlier?"). Each user has a main thread,
`copilot:<user id>` (and `tanstack:<user id>`). **+ New chat** on `/agent`
opens `/agent?thread=<uuid>`, which is the thread `copilot:<user id>:<uuid>`:
a fresh conversation, and the URL keeps you in it after a reload.

The TanStack page loads its chat from the agent on every page load (`history.py`).
Tool results are saved with the id TanStack gives them (`tool-<call id>`, see
`run_tools` in `agent.py`). When `useChat` sends the history back, the ids match
and the adapter skips them instead of saving them twice.

Separately, Next.js keeps a page you navigate away from alive in the background
(`cacheComponents` uses React `<Activity>`), so going back through the menu shows
the page exactly as you left it, even before any reload.

## CopilotKit or TanStack?

| | CopilotKit (`/agent`) | TanStack `useChat` (`/agent-tanstack`) |
|---|---|---|
| Chat UI | Ready-made (`<CopilotChat>`) | You write it (like `/chat`) |
| Goes through | A Next.js route (`app/api/copilotkit`) | Straight to FastAPI |
| Chat after reload | Yes, until Next.js restarts | Yes (from Postgres) |
| Tool calls on screen | `useDefaultRenderTool` | Message parts of type `tool-call` |
| Size | ~1,100 npm packages | Already installed |

## Things to know before using this for real

- **The Python server has no login.** It listens on `127.0.0.1` only, so only
  your machine can reach it. Anyone who can reach it could read any thread by
  guessing its id. The CopilotKit route checks the login, but the TanStack page
  calls Python directly. Before deploying, add auth to FastAPI (check the
  session or a token) and decide threads there.
- **Gemini free tier is slow and limited.** Replies can take 10 to 20 seconds
  to start, and you can hit 429/503 errors.
- **Windows:** `main.py` starts uvicorn on a `SelectorEventLoop`, because the
  Postgres driver (psycopg) cannot run on Windows' default event loop.
- `ag-ui-langgraph`'s README passes the graph straight to
  `add_langgraph_fastapi_endpoint`; the code needs it wrapped in
  `LangGraphAgent(name=..., graph=...)`, as `main.py` does.

## Sources

- LangGraph: install, quickstart (Graph API), add memory (Postgres checkpointer) at docs.langchain.com
- Gemini in LangChain: `langchain-google-genai` (reads `GOOGLE_API_KEY`, then `GEMINI_API_KEY`)
- `ag-ui-langgraph` on PyPI and its source in `.venv`
- CopilotKit docs: Deep Agents with FastAPI (`HttpAgent`, `CopilotRuntime`, `CopilotChat`)
