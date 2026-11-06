"""FastAPI server that exposes the LangGraph agent to the page's useChat.

POST   /agent                 run the agent: a new message, or the answers to the
                              approvals it waits on. Streams the reply in the AI
                              SDK's UI message stream format (ui_stream.py). Then
                              deletes the thread if its chat is gone (the
                              delete_chat_history tool).
GET    /agent?threadId=...    the saved chat and any approval still waiting
DELETE /agent?threadId=...    clear that chat from the agent's memory
GET    /agent/health          simple health check

The reply runs inside the POST request: closing the page (or the Stop button)
stops it. Steps it already finished stay saved in the checkpointer.
"""

import asyncio
import logging
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from langchain.messages import HumanMessage
from langgraph.types import Command
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool
from pydantic import BaseModel

from history import to_ui_messages
from ui_stream import HEADERS, pending_interrupts, stream_reply

# Reuse the Next.js app's .env: GEMINI_API_KEY and DATABASE_URL live there.
load_dotenv(Path(__file__).parent.parent / ".env")

from agent import THINKING_LEVELS, build_graph, latest_context_usage  # noqa: E402  (needs the env vars loaded first)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # The checkpointer stores every conversation (per thread_id) in the same
    # Postgres as the app. It needs a running event loop, so it is made here.
    # The connection settings are the ones LangGraph's Postgres saver needs.
    async with AsyncConnectionPool(
        os.environ["DATABASE_URL"],
        kwargs={"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row},
    ) as pool:
        checkpointer = AsyncPostgresSaver(pool)
        await checkpointer.setup()  # creates LangGraph's tables once; safe to repeat
        app.state.pool = pool
        app.state.checkpointer = checkpointer
        app.state.graph = build_graph(checkpointer, pool)
        yield


app = FastAPI(lifespan=lifespan)
logger = logging.getLogger(__name__)

# Cleanups still running. asyncio keeps only a weak reference to a task, so one
# nobody holds can be garbage-collected before it finishes.
_cleanups: set[asyncio.Task] = set()


async def forget_deleted_chat(app: FastAPI, thread_id: str):
    """Deletes the thread's saved messages when its chat row is gone. The
    delete_chat_history tool deletes the row during the run, but the thread can only
    go once the run has stopped writing to it, which is now."""
    try:
        async with app.state.pool.connection() as db:
            cursor = await db.execute("SELECT 1 FROM chats WHERE id = %s", (thread_id,))
            exists = await cursor.fetchone() is not None
        if not exists:
            await app.state.checkpointer.adelete_thread(thread_id)
    except Exception:
        logger.exception("Could not clean up thread %s", thread_id)


class Approval(BaseModel):
    id: str  # the interrupt's id
    approved: bool


class ChatRequest(BaseModel):
    """What the page's useChat sends (prepareSendMessagesRequest in
    lib/use-agent-chat.ts): only what is new, since the checkpointer has the rest.
    Either a message, or the user's answers to the approvals the run waits on."""

    threadId: str
    messageId: str | None = None
    text: str | None = None
    thinkingLevel: str | None = None
    approvals: list[Approval] | None = None


# At most 25 graph steps per run (LangGraph's default), so a model that keeps
# calling tools cannot loop forever. One tool round trip is 3 steps (model, the
# approval check, tools); a search, a read and the answer take about 8.
RECURSION_LIMIT = 25


@app.post("/agent")
async def run_agent(body: ChatRequest, request: Request):
    graph = request.app.state.graph
    config = {"configurable": {"thread_id": body.threadId}, "recursion_limit": RECURSION_LIMIT}
    resumed: set[str] = set()
    denied: set[str] = set()
    if body.approvals is not None:
        # Every waiting approval needs an answer to resume. One the page did not
        # send counts as denied: never run a tool nobody said yes to.
        waiting = pending_interrupts(await graph.aget_state(config))
        if not waiting:
            return JSONResponse({"error": "Nothing is waiting for an answer."}, status_code=409)
        approved = {a.id for a in body.approvals if a.approved}
        for i in waiting:
            resumed.add(i.value["tool_call_id"])
            if i.id not in approved:
                denied.add(i.value["tool_call_id"])
        # per_call mode (agent.py): each interrupt takes one decision, keyed by its id.
        graph_input = Command(resume={i.id: {"type": "approve" if i.id in approved else "reject"} for i in waiting})
    elif body.text and body.text.strip():
        graph_input = {"messages": [HumanMessage(content=body.text, id=body.messageId)]}
        # Saved with the thread, so a run resumed after an approval keeps it.
        if body.thinkingLevel in THINKING_LEVELS:
            graph_input["thinking_level"] = body.thinkingLevel
    else:
        return JSONResponse({"error": "Send a message or the answers to the approvals."}, status_code=400)

    async def events():
        try:
            async for line in stream_reply(graph, graph_input, config, resumed=resumed, denied=denied):
                yield line
        finally:
            # A task, not an await: when the page closes mid-reply this request is
            # cancelled, and an await here would be cancelled with it.
            task = asyncio.create_task(forget_deleted_chat(request.app, body.threadId))
            _cleanups.add(task)
            task.add_done_callback(_cleanups.discard)

    return StreamingResponse(events(), media_type="text/event-stream", headers=HEADERS)


@app.get("/agent/health")
def health():
    return {"status": "ok"}


@app.get("/agent")
async def chat_history(threadId: str, request: Request):
    """No login check: anyone who can reach this server and knows a thread id
    can read it. Fine on 127.0.0.1, not on a public server."""
    config = {"configurable": {"thread_id": threadId}}
    state = await request.app.state.graph.aget_state(config)
    messages = state.values.get("messages", [])
    return {
        # With the approvals still waiting, so a reloaded page shows them again.
        "messages": to_ui_messages(messages, pending_interrupts(state)),
        "context": latest_context_usage(messages),
    }


@app.delete("/agent")
async def clear_chat(threadId: str, request: Request):
    """Delete a thread from the agent's memory, so the next message starts fresh.

    Same caveat as above: no login check, so keep this server private.
    """
    await request.app.state.checkpointer.adelete_thread(threadId)
    return {"deleted": threadId}


# The chat page calls this server straight from the browser (port 3000 -> 8123).
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
