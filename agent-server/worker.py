"""The worker: claims queued runs from Postgres and runs the agent for them.

The API (main.py) only queues runs. Run one or more workers next to it:

    uv run worker.py

Each worker runs up to WORKER_CONCURRENCY replies at once. If a worker dies
mid-reply, its heartbeat stops and a worker claims that run again and continues
it from the last step LangGraph saved (see runs.py). Stopping a worker with
Ctrl+C hands its running replies back the same way.
"""

import asyncio
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg_pool import AsyncConnectionPool

import runs

# Reuse the Next.js app's .env: GEMINI_API_KEY and DATABASE_URL live there.
load_dotenv(Path(__file__).parent.parent / ".env")

from agent import build_agui_agent, build_graph, threads_to_delete  # noqa: E402  (needs the env vars loaded first)

CONCURRENCY = int(os.environ.get("WORKER_CONCURRENCY", "4"))


async def main() -> None:
    async with (
        AsyncPostgresSaver.from_conn_string(os.environ["DATABASE_URL"]) as checkpointer,
        AsyncConnectionPool(os.environ["DATABASE_URL"], kwargs={"autocommit": True}, open=False) as pool,
    ):
        await pool.open()
        runs.init(pool)
        await checkpointer.setup()
        agent = build_agui_agent(build_graph(checkpointer))

        async def after_run(thread_id: str) -> None:
            # The user approved delete_chat_history during this reply: delete
            # the thread now that the agent has stopped writing to it.
            if thread_id in threads_to_delete:
                threads_to_delete.discard(thread_id)
                await checkpointer.adelete_thread(thread_id)

        slots = asyncio.Semaphore(CONCURRENCY)
        running: set[asyncio.Task] = set()
        print(f"worker ready: up to {CONCURRENCY} replies at once", flush=True)
        try:
            while True:
                await slots.acquire()  # wait for a free slot before taking work
                job = await runs.claim_next()
                if job is None:
                    slots.release()
                    await asyncio.sleep(runs.POLL_SECONDS)
                    continue
                print(f"claimed {job[0]} (attempt {job[3]})", flush=True)
                task = asyncio.create_task(runs.drive_run(agent, job, after_run))
                running.add(task)
                task.add_done_callback(running.discard)
                task.add_done_callback(lambda _: slots.release())
        finally:
            # Ctrl+C: cancel our replies without finishing them, so another
            # worker takes them over once their heartbeat goes quiet.
            for task in running:
                task.cancel()
            await asyncio.gather(*running, return_exceptions=True)


if __name__ == "__main__":
    # psycopg's async driver cannot run on Windows' default (Proactor) event loop.
    loop_factory = asyncio.SelectorEventLoop if sys.platform == "win32" else None
    try:
        asyncio.run(main(), loop_factory=loop_factory)
    except KeyboardInterrupt:
        pass
