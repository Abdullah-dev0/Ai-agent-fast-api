"""FastAPI server that exposes the LangGraph agent over AG-UI.

POST   /agent                 start a reply; streams its AG-UI events (the page's
                              useAgentChat reads them). When it is over, deletes the
                              thread if its chat is gone (the delete_chat_history tool).
GET    /agent?threadId=...    the saved chat, the reply still running and any
                              approval still waiting
GET    /agent?runId=...       join a running reply: its events from the start, then live
POST   /agent/stop?threadId=  the Stop button: ends the chat's running reply
DELETE /agent?threadId=...    clear that chat from the agent's memory
GET    /agent/health          simple health check

The reply runs in the background (runs.py): closing the page or switching chats does
not stop it, and the page joins it again when it comes back. Only the Stop button
ends it. Steps it already finished stay saved in the checkpointer.
"""

import asyncio
import logging
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from ag_ui.core import BaseEvent, EventType, MessagesSnapshotEvent, RunErrorEvent
from ag_ui.core.types import RunAgentInput
from ag_ui.encoder import EventEncoder
from ag_ui_langgraph.interrupts import lg_interrupt_to_agui
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

import runs
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
    """The same as ag-ui-langgraph's add_langgraph_fastapi_endpoint, but the run goes
    on in the background (runs.py) and this response only follows it."""
    if runs.active_run(input_data.thread_id):
        return JSONResponse({"error": "This chat is already replying."}, status_code=409)
    app = request.app
    encoder = EventEncoder(accept=request.headers.get("accept"))
    # One copy per run: the adapter keeps per-run state on the instance.
    agent = app.state.agent.clone()
    # useChat sends a message's extra data (sendMessage's body) in forwardedProps;
    # the agent reads the thinking level from its state (ChatState in agent.py).
    if level := (input_data.forwarded_props or {}).get("thinkingLevel"):
        input_data = input_data.model_copy(update={"state": {**(input_data.state or {}), "thinking_level": level}})

    async def work(run: runs.Run):
        try:
            async for event in agent.run(input_data):
                if (event := without_reasoning_text(event)) is not None:
                    await run.publish(event)
        except Exception as error:
            logger.exception("Run failed in thread %s", input_data.thread_id)
            await run.publish(RunErrorEvent(message=str(error)))
        finally:
            await forget_deleted_chat(app, input_data.thread_id)

    run = runs.start(input_data.thread_id, input_data.run_id, work)
    return StreamingResponse(run.follow(encoder), media_type=encoder.get_content_type())


@app.post("/agent/stop")
async def stop_reply(threadId: str):
    return {"stopped": runs.stop(threadId)}


@app.get("/agent/health")
def health():
    return {"status": "ok"}


@app.get("/agent")
async def agent_get(request: Request, threadId: str | None = None, runId: str | None = None):
    """useChat asks two things of this URL: ?threadId= is the saved chat on load,
    ?runId= (with offset=-1) joins the reply that is running."""
    if runId:
        run = runs.run_by_id(runId)
        if run is None:  # over already: the saved chat has it all
            return JSONResponse({"error": "No such run."}, status_code=404)
        encoder = EventEncoder(accept=request.headers.get("accept"))
        return StreamingResponse(run.follow(encoder), media_type=encoder.get_content_type())
    if threadId is None:
        return JSONResponse({"error": "threadId or runId is required."}, status_code=422)
    return await chat_history(threadId, request)


async def chat_history(threadId: str, request: Request):
    """The saved chat, in the shape useChat's `persistence: true` loads it in
    (TanStack AI's ChatHydrationResult). It may add limit/before for paging;
    the whole chat is always sent.

    No login check: anyone who can reach this server and knows a thread id
    can read it. Fine on 127.0.0.1, not on a public server."""
    config = {"configurable": {"thread_id": threadId}}
    state = await request.app.state.graph.aget_state(config)
    pending = [i for task in state.tasks for i in task.interrupts]
    messages = to_ui_messages(state.values.get("messages", []))
    run = runs.active_run(threadId)
    if run:
        # The page rebuilds the reply that is still running from the run's own events
        # (the join above), so what the checkpointer has of it is left out here.
        last_user = max((i for i, m in enumerate(messages) if m["role"] == "user"), default=-1)
        messages = messages[: last_user + 1]
    return {
        "messages": messages,
        "activeRun": {"runId": run.run_id} if run else None,
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
