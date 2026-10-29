# Agent server (Python)

A LangChain agent (Gemini + four tools) served by FastAPI. The Next.js app's
`/agent-tanstack` page talks to it with TanStack AI's `useChat`.

## Run it

You need the Next.js app's `.env` (it has `GEMINI_API_KEY` and `DATABASE_URL`),
Postgres running (`docker compose up -d`) and the tables (`npm run migrate`),
both in the project root. Then:

```bash
cd agent-server
uv sync              # install the Python packages (first time only)
uv run main.py       # the API on http://127.0.0.1:8123
```

Then, in the project root, `npm run dev`, sign in and open **Agent (TanStack)**.

## The files

| File | What it does |
|---|---|
| `tools.py` | The tools: current time, weather (Open-Meteo), a safe calculator, and `delete_chat_history`, which needs the user's approval. |
| `agent.py` | The agent: LangChain's `create_agent`, with `HumanInTheLoopMiddleware` for the approval. Also the AG-UI wrapper. |
| `main.py` | The API: `ag-ui-langgraph`'s endpoint to run the agent, plus history and clear. |
| `history.py` | Turns a saved thread into the `{ id, role, parts }` messages `useChat` shows after a reload, reasoning included. |

## How one message travels

```
Browser ──POST /agent──> FastAPI ──> create_agent (LangGraph) ──> Gemini + tools
   ^                        │                │
   └── AG-UI events (SSE) ──┘                └── saves every step in Postgres (checkpointer)
```

**AG-UI** is the shared language: a standard list of streamed events ("run
started", "a piece of text", "tool called", "reasoning", "run finished").
`ag-ui-langgraph` turns the agent's output into those events, and `useChat`
reads them.

| Route | What it does |
|---|---|
| `POST /agent` | Runs the agent and streams the reply. `ag-ui-langgraph`'s `add_langgraph_fastapi_endpoint`. |
| `GET /agent?threadId=` | The saved chat and any approval still waiting (`useChat`'s `persistence: true` calls it on page load). |
| `DELETE /agent?threadId=` | Deletes the thread (the Clear chat button, and after an approved `delete_chat_history`). |
| `GET /agent/health` | Health check. |

The reply runs inside the POST request. **Stop** (or closing the page) closes
the connection, and that stops the reply. Steps it already finished stay saved,
so a reload shows them. A reload during a reply does not rejoin it: TanStack's
documented way to do that needs its own JavaScript server.

## The agent (`agent.py`)

`create_agent` runs the usual loop: ask Gemini, run the tools it asked for,
give it the results, repeat until it answers in plain text. At most 12 steps
per reply (`recursion_limit`).

Two middlewares:

- `HumanInTheLoopMiddleware(interrupt_mode="per_call")` pauses before
  `delete_chat_history` and asks the user (docs: LangChain "Human-in-the-loop").
- `tanstack_tool_ids` saves each tool result with the id TanStack gives it
  (`tool-<call id>`). `useChat` sends the whole history back with every
  message, and the adapter adds any message whose id it has not saved yet, so
  matching ids stop tool results being saved twice.

## Approvals

1. Gemini calls `delete_chat_history`. The middleware pauses the run with
   `{ type: "tool_approval", name, args, description }`. The run ends with
   `RUN_FINISHED` outcome `interrupt`.
2. The page shows Approve / Deny. TanStack lists interrupts from a non-TanStack
   server as `unbound`, so the page answers with `useChat`'s
   `resumeInterruptsUnsafe`, sending `{ type: "approve" }` or `{ type: "reject" }`.
   The adapter passes it to the middleware as `Command(resume=...)`.
3. Deny: the tool does not run, and Gemini is told so. Approve: the tool runs,
   and when the reply ends the page calls `DELETE /agent` and clears the screen.

A waiting approval is saved by the checkpointer, so after a reload
`GET /agent?threadId=` returns it and the buttons come back. `useChat` drops a
restored approval without a run id, and LangGraph saves none, so the server
sends the id of the checkpoint the run paused at.

A denied call streams no result (the middleware answers without running the
tool), so the page labels it "Not run" until a reload shows the reason.

## Reasoning

`include_thoughts=True` makes Gemini return summaries of its reasoning. The
adapter streams them as `REASONING_*` events, TanStack shows them as `thinking`
parts, and `history.py` restores them after a reload.

The adapter ends every run with a `MESSAGES_SNAPSHOT` that leaves the reasoning
out, and TanStack replaces its messages with it, so every reasoning section on
the page vanished when a reply finished. `ChatAgent` (in `agent.py`) drops that
one event. The streamed ids match the snapshot's, so nothing else changes.

## Things to know before using this for real

- **The Python server has no login.** It listens on `127.0.0.1` only. Anyone
  who can reach it could read, run or delete any thread by guessing its id.
  Before deploying, add auth to FastAPI and decide threads there.
- **The reload protocol is copied from TanStack's client.** `GET /agent` returns
  the shape `useChat` reads (`ai-client/src/chat-client.ts`), which TanStack's
  guides do not document for non-TanStack servers. Check it after upgrading
  `@tanstack/ai-react`.
- **Gemini free tier is slow and limited.** Replies can take 10 to 20 seconds
  to start, and you can hit 429/503 errors.
- **Windows:** the server runs on a `SelectorEventLoop`, because the Postgres
  driver (psycopg) cannot run on Windows' default event loop.

## Sources

- LangChain: "Agents" (`create_agent`) and "Human-in-the-loop" (`HumanInTheLoopMiddleware`, `per_call`) at docs.langchain.com
- LangGraph: Postgres checkpointer, interrupts at docs.langchain.com
- Gemini in LangChain: `langchain-google-genai` (`include_thoughts`; reads `GOOGLE_API_KEY`, then `GEMINI_API_KEY`)
- `ag-ui-langgraph` (`add_langgraph_fastapi_endpoint`, interrupts, `RunAgentInput.resume`) in `.venv`
- TanStack AI: `node_modules/@tanstack/ai/skills/ai-core` (custom-backend-integration, client-persistence), and `ai-client/src` for the hydrate shape
