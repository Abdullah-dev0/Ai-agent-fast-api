"""FastAPI server that exposes the LangGraph agent over AG-UI.

POST /agent        streams the agent's reply as AG-UI events (what CopilotKit
                   and TanStack's useChat both understand)
GET  /agent/health simple health check

Run it with:  uv run main.py
"""

import asyncio
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from ag_ui_langgraph import LangGraphAgent, add_langgraph_fastapi_endpoint
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

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
        agent = LangGraphAgent(
            name="assistant",
            description="Gemini agent with tools",
            graph=graph,
            # RAW events copy LangGraph's internal events for debugging only and
            # are most of the bytes on the wire; the chat UIs do not need them.
            emit_raw_events=False,
        )
        add_langgraph_fastapi_endpoint(app, agent, "/agent")
        yield


app = FastAPI(lifespan=lifespan)

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
