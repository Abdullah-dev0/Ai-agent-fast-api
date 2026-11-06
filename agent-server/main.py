"""FastAPI server that exposes the LangGraph agent over AG-UI.

POST   /agent                 run the agent; streams AG-UI events (the page's
                              useAgentChat reads them). Then deletes the thread if
                              its chat is gone (the delete_chat_history tool).
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
from ag_ui.core import BaseEvent, EventType, MessagesSnapshotEvent
from ag_ui.core.types import RunAgentInput
from ag_ui.encoder import EventEncoder
from ag_ui_langgraph.interrupts import lg_interrupt_to_agui
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from history import to_ui_messages

# Reuse the Next.js app's .env: GEMINI_API_KEY and DATABASE_URL live there.
load_dotenv(Path(__file__).parent.parent / ".env")

from agent import build_agui_agent, build_graph  # noqa: E402  (needs the env vars loaded first)

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
        app.state.agent = build_agui_agent(app.state.graph)
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


def without_reasoning_text(event: BaseEvent) -> BaseEvent | None:
    """The page shows only that the model thought and for how long, like ChatGPT,
    so the reasoning itself never leaves the server: some providers send their raw
    reasoning, not a summary. Its start and end still go out, for "Thinking…"."""
    if event.type in (EventType.REASONING_MESSAGE_CONTENT, EventType.REASONING_ENCRYPTED_VALUE):
        return None
    if isinstance(event, MessagesSnapshotEvent):
        return event.model_copy(update={"messages": [m for m in event.messages if m.role != "reasoning"]})
    return event


@app.post("/agent")
async def run_agent(input_data: RunAgentInput, request: Request):
    """The same as ag-ui-langgraph's add_langgraph_fastapi_endpoint, plus the cleanup."""
    encoder = EventEncoder(accept=request.headers.get("accept"))
    # One copy per request: the adapter keeps per-run state on the instance.
    agent = request.app.state.agent.clone()
    # useChat sends a message's extra data (sendMessage's body) in forwardedProps;
    # the agent reads the thinking level from its state (ChatState in agent.py).
    if level := (input_data.forwarded_props or {}).get("thinkingLevel"):
        input_data = input_data.model_copy(update={"state": {**(input_data.state or {}), "thinking_level": level}})

    async def events():
        try:
            async for event in agent.run(input_data):
                if (event := without_reasoning_text(event)) is not None:
                    yield encoder.encode(event)
        finally:
            # A task, not an await: when the page closes mid-reply this request is
            # cancelled, and an await here would be cancelled with it.
            task = asyncio.create_task(forget_deleted_chat(request.app, input_data.thread_id))
            _cleanups.add(task)
            task.add_done_callback(_cleanups.discard)

    return StreamingResponse(events(), media_type=encoder.get_content_type())


@app.get("/agent/health")
def health():
    return {"status": "ok"}


@app.get("/agent")
async def chat_history(threadId: str, request: Request):
    """The saved chat, in the shape useChat's `persistence: true` loads it in
    (TanStack AI's ChatHydrationResult). It may add limit/before for paging;
    the whole chat is always sent.

    No login check: anyone who can reach this server and knows a thread id
    can read it. Fine on 127.0.0.1, not on a public server."""
    config = {"configurable": {"thread_id": threadId}}
    state = await request.app.state.graph.aget_state(config)
    pending = [i for task in state.tasks for i in task.interrupts]
    return {
        "messages": to_ui_messages(state.values.get("messages", [])),
        "activeRun": None,  # a reply runs inside its POST request: none to rejoin
        # Approvals still waiting for an answer, so a reloaded page shows them again.
        # useChat needs a run id with them; LangGraph saves none, so this names the
        # checkpoint the run paused at (the adapter resumes from the latest anyway).
        # Off TanStack's documented path, like lib/langgraph-approvals.ts.
        "interrupts": {
            "runId": state.config["configurable"]["checkpoint_id"],
            "pending": [lg_interrupt_to_agui(i).model_dump(by_alias=True, exclude_none=True) for i in pending],
        }
        if pending
        else None,
        "page": {"truncated": False},
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
