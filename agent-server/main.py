"""FastAPI server that exposes the LangGraph agent over AG-UI.

It never runs the agent itself: POST /agent queues a run, and worker.py runs it.
Start both:  uv run main.py   and   uv run worker.py

POST   /agent                       queue a run; streams its AG-UI events (TanStack's
                                    useChat reads them)
GET    /agent?threadId=...          the saved chat, plus the run still being
                                    written (for useChat's `persistence: true`)
GET    /agent?runId=...&offset=...  rejoin a run after a refresh (runs.py)
POST   /agent/stop?threadId=...     stop the reply being written for that thread
DELETE /agent?threadId=...          clear that chat from the agent's memory
GET    /agent/health                simple health check
"""

import asyncio
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from ag_ui.core import RunAgentInput
from ag_ui_langgraph.interrupts import lg_interrupt_to_agui
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg_pool import AsyncConnectionPool

import runs
from history import to_ui_messages

# Reuse the Next.js app's .env: GEMINI_API_KEY and DATABASE_URL live there.
load_dotenv(Path(__file__).parent.parent / ".env")

from agent import build_graph  # noqa: E402  (needs the env vars loaded first)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # One Postgres connection pool for the whole server life. The checkpointer
    # stores every conversation (per thread_id) in the same Postgres as the app.
    async with (
        AsyncPostgresSaver.from_conn_string(os.environ["DATABASE_URL"]) as checkpointer,
        # Connections for the reply logs (runs.py). autocommit: each query stands
        # alone, so a saved event is visible to other servers immediately.
        AsyncConnectionPool(os.environ["DATABASE_URL"], kwargs={"autocommit": True}, open=False) as pool,
    ):
        await pool.open()
        runs.init(pool)
        await checkpointer.setup()  # creates LangGraph's tables once; safe to repeat
        # The API only reads threads (history) and deletes them (clear); the
        # worker is what runs the graph.
        app.state.graph = build_graph(checkpointer)
        app.state.checkpointer = checkpointer
        yield


app = FastAPI(lifespan=lifespan)


def sse(events) -> StreamingResponse:
    return StreamingResponse(events, media_type="text/event-stream")


# Our own POST instead of ag-ui-langgraph's add_langgraph_fastapi_endpoint: that
# one runs the agent inside the response, so a refresh would stop the reply.
@app.post("/agent")
async def run_agent(input: RunAgentInput, request: Request):
    exists = await runs.run_exists(input.run_id)
    last_seen = request.headers.get("last-event-id")
    if exists and last_seen is not None:
        # The connection dropped and useChat retried the same POST: do not run the
        # agent again, just continue the log after the last event it received.
        return sse(runs.read(input.run_id, runs.parse_offset(last_seen)))
    if not exists:
        await runs.enqueue_run(input)  # a worker (worker.py) runs it
    return sse(runs.read(input.run_id, 0))


@app.get("/agent")
async def chat_history_or_rejoin(
    request: Request, threadId: str | None = None, runId: str | None = None, offset: str | None = None
):
    """No login check: anyone who can reach this server and knows a thread or run
    id can read it. Fine on 127.0.0.1, not on a public server."""
    if runId is not None:
        # A reloaded page rejoining a reply: replay it (offset -1 = from the
        # start) and keep streaming until it ends.
        if not await runs.run_exists(runId):
            raise HTTPException(404, "Unknown or expired run")
        return sse(runs.read(runId, runs.parse_offset(request.headers.get("last-event-id") or offset)))

    if threadId is None:
        raise HTTPException(400, "threadId or runId is required")
    state = await request.app.state.graph.aget_state({"configurable": {"thread_id": threadId}})
    messages = state.values.get("messages", []) if state else []
    run_id = await runs.active_run(threadId)
    # Approvals still waiting for an answer, so a reloaded page shows them again.
    pending = [i for task in (state.tasks if state else ()) for i in task.interrupts]
    interrupts = None
    if pending and not run_id:
        interrupts = {
            "runId": await runs.latest_run(threadId) or "",
            "pending": [lg_interrupt_to_agui(i).model_dump(by_alias=True, exclude_none=True) for i in pending],
        }
    return {
        "messages": to_ui_messages(messages),
        # useChat sees this, then rejoins with GET ?runId=...&offset=-1.
        "activeRun": {"runId": run_id} if run_id else None,
        "interrupts": interrupts,
    }


@app.post("/agent/stop")
async def stop_run(threadId: str):
    """Stop the reply that is being written for this thread.

    Needed because replies run in the background: closing the connection (which
    is all useChat's stop() does) no longer stops them. Same caveat as above:
    no login check, so keep this server private.
    """
    return {"stopped": await runs.cancel_run(threadId)}


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
