"""FastAPI server that exposes the LangGraph agent over AG-UI.

POST   /agent                       run the agent; streams AG-UI events (CopilotKit
                                    and TanStack's useChat both read them)
GET    /agent?threadId=...          the saved chat, plus the run still being
                                    written (for useChat's `persistence: true`)
GET    /agent?runId=...&offset=...  rejoin a run after a refresh (runs.py)
DELETE /agent?threadId=...          clear that chat from the agent's memory
GET    /agent/health                simple health check

Run it with:  uv run main.py
"""

import asyncio
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from ag_ui.core import RunAgentInput
from ag_ui_langgraph import LangGraphAgent
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

from history import to_ui_messages
from runs import active, parse_offset, runs, start_run

# Reuse the Next.js app's .env: GEMINI_API_KEY and DATABASE_URL live there.
load_dotenv(Path(__file__).parent.parent / ".env")

from agent import build_graph  # noqa: E402  (needs the env vars loaded first)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # One Postgres connection pool for the whole server life. The checkpointer
    # stores every conversation (per thread_id) in the same Postgres as the app.
    async with AsyncPostgresSaver.from_conn_string(os.environ["DATABASE_URL"]) as checkpointer:
        await checkpointer.setup()  # creates LangGraph's tables once; safe to repeat
        graph = build_graph(checkpointer)
        app.state.graph = graph  # the history route reads threads from it
        app.state.checkpointer = checkpointer  # the clear route deletes threads with it
        app.state.agent = LangGraphAgent(
            name="assistant",
            description="Gemini agent with tools",
            graph=graph,
            # RAW events copy LangGraph's internal events for debugging only and
            # are most of the bytes on the wire; the chat UIs do not need them.
            emit_raw_events=False,
        )
        yield


app = FastAPI(lifespan=lifespan)


def sse(events) -> StreamingResponse:
    return StreamingResponse(events, media_type="text/event-stream")


# Our own POST instead of ag-ui-langgraph's add_langgraph_fastapi_endpoint: that
# one runs the agent inside the response, so a refresh would stop the reply.
@app.post("/agent")
async def run_agent(input: RunAgentInput, request: Request):
    log = runs.get(input.run_id)
    last_seen = request.headers.get("last-event-id")
    if log and last_seen is not None:
        # The connection dropped and useChat retried the same POST: do not run the
        # agent again, just continue the log after the last event it received.
        return sse(log.read(parse_offset(last_seen)))
    if log is None:
        log = start_run(request.app.state.agent, input)
    return sse(log.read(0))


@app.get("/agent")
async def chat_history_or_rejoin(
    request: Request, threadId: str | None = None, runId: str | None = None, offset: str | None = None
):
    """No login check: anyone who can reach this server and knows a thread or run
    id can read it. Fine on 127.0.0.1, not on a public server."""
    if runId is not None:
        # A reloaded page rejoining a reply: replay it (offset -1 = from the
        # start) and keep streaming until it ends.
        log = runs.get(runId)
        if log is None:
            raise HTTPException(404, "Unknown or expired run")
        return sse(log.read(parse_offset(request.headers.get("last-event-id") or offset)))

    if threadId is None:
        raise HTTPException(400, "threadId or runId is required")
    state = await request.app.state.graph.aget_state({"configurable": {"thread_id": threadId}})
    messages = state.values.get("messages", []) if state else []
    run_id = active.get(threadId)
    return {
        "messages": to_ui_messages(messages),
        # useChat sees this, then rejoins with GET ?runId=...&offset=-1.
        "activeRun": {"runId": run_id} if run_id else None,
        "interrupts": None,
    }


@app.delete("/agent")
async def clear_chat(threadId: str, request: Request):
    """Delete a thread from the agent's memory, so the next message starts fresh.

    Same caveat as above: no login check, so keep this server private.
    """
    await request.app.state.checkpointer.adelete_thread(threadId)
    return {"deleted": threadId}


@app.get("/agent/health")
def health():
    return {"status": "ok", "agent": {"name": "assistant"}}


# The TanStack page calls this server straight from the browser (port 3000 -> 8123).
# The CopilotKit page goes through Next.js, so it does not need this.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

if __name__ == "__main__":
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=8123))
    # psycopg's async driver cannot run on Windows' default (Proactor) event
    # loop, so start the server on a SelectorEventLoop there.
    loop_factory = asyncio.SelectorEventLoop if sys.platform == "win32" else None
    asyncio.run(server.serve(), loop_factory=loop_factory)
