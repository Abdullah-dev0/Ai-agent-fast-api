"""FastAPI server that exposes the LangGraph agent over AG-UI.

POST   /agent                 run the agent; streams AG-UI events (the page's
                              useAgentChat reads them). ag-ui-langgraph's own endpoint.
GET    /agent?threadId=...    the saved chat and any approval still waiting
DELETE /agent?threadId=...    clear that chat from the agent's memory
GET    /agent/health          simple health check

The reply runs inside the POST request: closing the page (or the Stop button)
stops it. Steps it already finished stay saved in the checkpointer.
"""

import asyncio
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from ag_ui_langgraph import add_langgraph_fastapi_endpoint
from ag_ui_langgraph.interrupts import lg_interrupt_to_agui
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
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
        app.state.checkpointer = checkpointer
        app.state.graph = build_graph(checkpointer, pool)
        # Registered here because the agent needs the checkpointer.
        add_langgraph_fastapi_endpoint(app, build_agui_agent(app.state.graph), "/agent")
        yield


app = FastAPI(lifespan=lifespan)


@app.get("/agent")
async def chat_history(threadId: str, request: Request):
    """No login check: anyone who can reach this server and knows a thread id
    can read it. Fine on 127.0.0.1, not on a public server."""
    config = {"configurable": {"thread_id": threadId}}
    state = await request.app.state.graph.aget_state(config)
    pending = [i for task in state.tasks for i in task.interrupts]
    return {
        "messages": to_ui_messages(state.values.get("messages", [])),
        # Approvals still waiting for an answer, so a reloaded page shows them
        # again. Same AG-UI shape as the interrupts in a live RUN_FINISHED.
        "interrupts": [lg_interrupt_to_agui(i).model_dump(by_alias=True, exclude_none=True) for i in pending],
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
