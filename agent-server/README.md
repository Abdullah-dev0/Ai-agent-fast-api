# Agent server (Python)

**Aragon**, a LangChain agent (Gemini + twelve tools, web search included) served
by FastAPI over AG-UI. The
Next.js app's `/agent` page talks to it with our own React hook,
`useAgentChat` (`lib/use-agent-chat.ts`).

## Run it

You need the Next.js app's `.env` (it has `GEMINI_API_KEY` and `DATABASE_URL`),
Postgres running (`docker compose up -d`) and the tables (`npm run migrate`),
both in the project root. Then:

```bash
cd agent-server
uv sync              # install the Python packages (first time only)
uv run main.py       # the API on http://127.0.0.1:8123
```

Then, in the project root, `npm run dev`, sign in and open **Agent**.

## The files

| File | What it does |
|---|---|
| `tools.py` | The tools: current time, weather (Open-Meteo), a safe calculator, `web_search` and `read_webpage` (Tavily), and `delete_chat_history`, plus `get_location`, `open_csv`, `query_csv`, `open_folder`, `read_files` and `write_file`, which the browser runs. `delete_chat_history`, `get_location`, `query_csv` and `read_files` need the user's approval, and `write_file` shows a diff to apply or reject. |
| `agent.py` | The agent: LangChain's `create_agent`, its name and system prompt (with today's date), and `HumanInTheLoopMiddleware` for the approval. Also the AG-UI wrapper. |
| `main.py` | The API: `ag-ui-langgraph`'s endpoint to run the agent, plus history and clear. |
| `history.py` | Turns a saved thread into the messages the page shows after a reload, in the same shape `useAgentChat` builds from the live stream. |

## How one message travels

```
Browser (useAgentChat) ──POST /agent──> FastAPI ──> create_agent (LangGraph) ──> Gemini + tools
   ^                                       │                │
   └──────── AG-UI events (SSE) ───────────┘                └── saves every step in Postgres (checkpointer)
```

**AG-UI** (https://docs.ag-ui.com) is the shared language: a standard list of
streamed events ("run started", "a piece of text", "tool called", "reasoning",
"run finished"). `ag-ui-langgraph` turns the agent's output into those events;
`useAgentChat` reads them.

| Route | What it does |
|---|---|
| `POST /agent` | Runs the agent and streams the reply. `ag-ui-langgraph`'s `add_langgraph_fastapi_endpoint`. |
| `GET /agent?threadId=` | `{ messages, interrupts }`: the saved chat and any approval or browser tool still waiting. |
| `DELETE /agent?threadId=` | Deletes the thread (the Delete chat button, and after an approved `delete_chat_history`). The page then removes the `chats` row. |
| `GET /agent/health` | Health check. |

The reply runs inside the POST request. **Stop** (or closing the page) closes
the connection, and that stops the reply. Steps it already finished stay saved,
so a reload shows them. A reload during a reply does not rejoin it. Switching to
another chat does not stop the reply: Next keeps the last 3 pages alive but hidden.
Past that, the page is dropped, the reply still finishes, and coming back while it
runs shows only what is saved so far.

## The page's side (`lib/use-agent-chat.ts`)

- **Send:** an AG-UI `RunAgentInput` with the `threadId`, a new `runId` and
  **only the new message**. The checkpointer already has the conversation, and
  the adapter adds any message it has not saved yet.
- **Read:** text, reasoning and tool events become the parts of one assistant
  message per reply (`text`, `reasoning`, `tool`); step and state events are
  ignored.
- **Tool arguments:** the adapter sends no `TOOL_CALL_ARGS` for Gemini (its
  first chunk holds the tool's name and arguments together), so the hook takes
  them from the `MESSAGES_SNAPSHOT` at the end of the run. Nothing else is read
  from the snapshot.
- **Stop:** aborts the request.
- **Load:** `GET /agent?threadId=` on mount. `history.py` returns the same
  message shape, so a reloaded chat looks like a live one.

## Approvals

1. Gemini calls `delete_chat_history`. `HumanInTheLoopMiddleware`
   (`interrupt_mode="per_call"`) pauses the run with
   `{ type: "tool_approval", name, args, description }`. The run ends with
   `RUN_FINISHED` outcome `interrupt` (`emit_interrupt_outcome=True`).
2. The page shows Approve / Deny. The answer is a new run with AG-UI's `resume`
   field: `[{ interruptId, status: "resolved", payload: { type: "approve" | "reject" } }]`.
   The adapter passes the payload to the middleware as `Command(resume=...)`.
   AG-UI requires one `resume` to answer every open interrupt, so the page
   answers all of them with one decision (two at once is rare).
3. Deny: the tool does not run, and Gemini is told so. Approve: the tool runs,
   and when the reply ends the page calls `DELETE /agent` and clears the screen.

A waiting approval is saved by the checkpointer, so after a reload
`GET /agent?threadId=` returns it (as AG-UI interrupts, the same shape as in
`RUN_FINISHED`) and the buttons come back.

A denied call streams no result (the middleware answers without running the
tool), so the page labels it "Not run" until a reload shows the reason.

## Browser tools (`get_location`)

Some tools need something only the browser has. The server declares the tool, but
the page runs it:

1. Gemini calls `get_location`, and the user approves it (see above). It asks every
   time, because a web page the agent reads could tell it to send the location
   somewhere through `read_webpage`.
2. The tool calls LangGraph's `interrupt({ type: "browser_tool", name, tool_call_id })`.
   The run ends with `RUN_FINISHED` outcome `interrupt`, the same as an approval.
3. `useAgentChat` sees `browser_tool`, runs the tool from `BROWSER_TOOLS` in
   `lib/browser-tools.ts`, and starts a new run with the result in `resume`.
4. LangGraph starts the tool function again and `interrupt()` returns that result,
   which becomes the tool's output. Anything above `interrupt()` runs twice, so keep
   side effects below it.

A tool that fails or gets no answer in 30 seconds returns `{ error }`, so the model
can ask the user instead of the reply failing. A waiting tool is saved like an
approval, so a reload runs it again.

The location is rounded to about 1 km in the browser, because it is saved with the
chat and sent to the model. The result comes from the browser, so it can be faked:
never use it for anything that needs to be true, like permissions or prices.

To add one: write the function in `BROWSER_TOOLS`, and a `@tool` in `tools.py` that
calls `_ask_browser()` the same way.

## Files on the user's computer (`open_csv`, `query_csv`)

Two browser tools that work together, so the agent can answer questions about a
file it never receives:

1. `open_csv` needs a click, because browsers only open a file picker from one. So
   the hook does not run it (`needsUser` in `lib/browser-tools.ts`): the page shows
   a card (`CsvPicker`), and picking a file or pressing Cancel answers the interrupt.
2. The browser reads the file (`lib/csv.ts`, up to 50 MB) and keeps it in memory for
   that chat. The model gets only the column names and stats and the first 3 rows.
3. `query_csv(op, metric, group_by, filter_column, filter_value, limit)` runs in the
   browser on that file. The arguments come from the model, carried in the interrupt.
   The page draws the result as bars (`CsvBars`), and the model gets the numbers.

Picking the file is the consent for the summary. Each `query_csv` asks for approval,
with a question built from its arguments (`describe_csv_query` in `agent.py`), for the
same reason as `get_location`: a web page could tell the agent to send results out.

The 3 sample rows and the results still go to the model and are saved with the chat,
so this is not private for a file where any one row is secret. The cells could also
hold instructions aimed at the agent, so treat them like web pages.

A reload forgets the file. The next `query_csv` returns an error telling the model
to call `open_csv` again.

## Folders on the user's computer (`open_folder`, `read_files`, `write_file`)

The agent can read and change real files, through the browser's File System Access
API (`lib/folder.ts`). This works only in Chrome, Edge and other Chromium browsers.
The browser only checks that a path is inside the picked folder, and it has no undo,
so every other rule here is ours:

| Rule | Why |
|---|---|
| The user picks the folder with a click (`FolderPicker`) | Browsers require it |
| `.env`, keys, `credentials*`, `.git`, `node_modules` and the like are never listed, read or written | What the agent reads goes to the model provider. This holds even if the user approves the read |
| `read_files` needs approval, naming each file, at most 5 per call | A web page or a file could tell the agent to send something out |
| Files are read whole or not at all (200 KB limit) | An agent that saw half a file and wrote it back would destroy the other half |
| `write_file` writes only from the Apply button in a card showing the diff (`WriteReview`) | The agent has no way to write by itself |
| A file must have been read before it is changed, and must not have changed since, checked again on Apply | So the user's own edits are never overwritten |
| The old version is copied to `.agent-backups/<time>/` first; if that fails, nothing is written | There is no other undo |
| There is no delete tool | Nothing asks for it yet, and it is the easiest way to lose data |

A write goes through `createWritable()`, which changes the real file only on
`close()`, so a crash midway leaves the original whole.

The backups stay in the folder until the user removes them, and restoring one is by
hand. Whole files go to the model and are saved with the chat in Postgres. A reload
forgets the folder, so the agent has to ask for it again.

## Web search (`web_search`, `read_webpage`)

Two tools that work together, so the agent researches instead of answering
from snippets:

1. `web_search(query, topic, time_range, max_results)` returns titles, URLs and
   short snippets.
2. `read_webpage(urls)` reads up to 3 of those pages in full (as markdown, cut
   at 8,000 characters each).
3. The agent answers from what it read and cites the pages as markdown links.

Both use [Tavily](https://docs.tavily.com), a search API made for agents. Its
servers fetch the pages, never this one.

- **Free, no key:** without `TAVILY_API_KEY`, `tavily-python` runs keyless;
  search and extract still work, with lower rate limits.
- **With a key** (`TAVILY_API_KEY` in `.env`, free plan 1,000 credits a month):
  higher limits. A basic search costs 1 credit, reading 5 pages costs 1.
- A failed search or read (rate limit, network) comes back to the model as
  `{"error": ...}`, so the reply goes on instead of failing.

The page shows these calls as "Searched “query” · 5 results" and "Read 2
pages", with the sources as links (`webToolView` in `components/agent-chat.tsx`).

The system prompt is built for every model call (`dynamic_prompt`) and includes
today's date. Without it Gemini trusted its training: asked for the latest
Python, it searched, then answered with a release two years old.

Web pages are untrusted text: a page could contain instructions aimed at the
agent. Here the worst case is a wrong answer (the tools with side effects or
private data, `delete_chat_history`, `get_location`, `query_csv`, `read_files` and
`write_file`, ask the user first), but keep that in mind before giving the agent
tools that act.

## Its name

The agent calls itself **Aragon** (`ASSISTANT_NAME` in `agent.py`). The system
prompt tells it never to say it is Gemini or to name the model or company
behind it. A prompt is not a guarantee: a determined user can sometimes get a
model to break such rules.

## Reasoning

`include_thoughts=True` makes Gemini return summaries of its reasoning. The
adapter streams them as `REASONING_*` events, the hook shows them as
`reasoning` parts, and `history.py` restores them after a reload.

## Long chats

Once a chat passes about 30,000 tokens (an estimate, not Gemini's own count),
`ContextEditingMiddleware` in `agent.py` replaces all but the 3 newest tool
results with a short note. The model can call the tool again if it needs one.

This only changes the copy sent to the model. The checkpointer keeps every
result, so the page still shows them after a reload. Plain text messages are
never removed, so a long chat with few tools still grows.

Do not add `SummarizationMiddleware` as things stand: it deletes the old messages
from the checkpointer, and `GET /agent` reads the chat from there, so they would
vanish from the page. It needs a separate table for the page's history first.

## Things to know before using this for real

- **The Python server has no login.** It listens on `127.0.0.1` only. Anyone
  who can reach it could read, run or delete any thread by guessing its id.
  Before deploying, put a route in front of it that checks the user's session
  and picks the thread itself, or add auth to FastAPI. The `/agent/[id]` page
  checks that the chat is yours, but the browser then calls this server directly.
- **Gemini free tier is slow and limited.** Replies can take 10 to 20 seconds
  to start, and you can hit 429/503 errors.
- **Windows:** the server runs on a `SelectorEventLoop`, because the Postgres
  driver (psycopg) cannot run on Windows' default event loop.

## Sources

- LangChain: "Agents" (`create_agent`) and "Human-in-the-loop" (`HumanInTheLoopMiddleware`, `per_call`) at docs.langchain.com
- LangChain: "Prebuilt middleware" (`ContextEditingMiddleware`, `SummarizationMiddleware`) at docs.langchain.com
- LangGraph: Postgres checkpointer, interrupts at docs.langchain.com
- AG-UI: events, `RunAgentInput`, interrupts and `resume` at docs.ag-ui.com
- Gemini in LangChain: `langchain-google-genai` (`include_thoughts`; reads `GOOGLE_API_KEY`, then `GEMINI_API_KEY`)
- `ag-ui-langgraph` (`add_langgraph_fastapi_endpoint`, interrupts, `RunAgentInput.resume`) in `.venv`
