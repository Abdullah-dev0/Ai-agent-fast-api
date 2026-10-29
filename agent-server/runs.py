"""Replies as jobs: survive a page refresh, a server restart, and a worker crash.

Two processes share Postgres (tables in db/migrations/0003 and 0004):

- The API (main.py) only puts a run in the queue (agent_runs, status 'queued')
  and streams its log to the browser. It never runs the agent.
- Workers (worker.py) claim queued runs and run them, saving every event in
  agent_run_events, numbered 1, 2, 3...

Each event goes out as "id: <number>" + "data: <event>". TanStack remembers the
last id it saw and sends it back when it reconnects, so we know where to resume:
the original POST, a reconnect (Last-Event-ID header), or a reloaded page
rejoining (GET ?runId=) all read the same log.

A running run refreshes its heartbeat every few seconds. If its worker dies, the
heartbeat stops and another worker claims the run and runs it again; LangGraph
continues from the last step it saved (the checkpointer). After MAX_ATTEMPTS
the run is closed with an error instead.
"""

import asyncio
import os
from collections.abc import AsyncIterator, Awaitable, Callable

from ag_ui.core import EventType, RunAgentInput, RunErrorEvent
from ag_ui.encoder import EventEncoder
from ag_ui_langgraph import LangGraphAgent
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

# The most one run may take, all model and tool calls included. Long jobs
# (research agents) need minutes, so the default is 30; past it the run is
# stopped, so a stuck reply cannot stay "running" (and costing) forever.
RUN_TIMEOUT_SECONDS = float(os.environ.get("AGENT_RUN_TIMEOUT_SECONDS", "1800"))
# A running run refreshes its heartbeat this often; one silent for longer than
# HEARTBEAT_DEAD_SECONDS belonged to a worker that crashed or was restarted.
HEARTBEAT_SECONDS = 2
HEARTBEAT_DEAD_SECONDS = 30
# How many times a run may be started (the first try plus retries after crashes).
MAX_ATTEMPTS = 3
# Readers (the API) and idle workers look for new work this often.
POLL_SECONDS = 0.5
# Finished runs are deleted after this long; their messages are already in
# the agent's own memory (the LangGraph checkpointer).
KEEP_FINISHED = "1 hour"

encoder = EventEncoder(accept="text/event-stream")
_pool: AsyncConnectionPool | None = None


def init(pool: AsyncConnectionPool) -> None:
    global _pool
    _pool = pool


async def _query(sql: str, params: tuple = ()) -> list[tuple]:
    assert _pool is not None, "runs.init(pool) was not called"
    async with _pool.connection() as conn:
        cursor = await conn.execute(sql, params)
        return await cursor.fetchall() if cursor.description else []


def _error(message: str, code: str) -> str:
    # The page reads RUN_ERROR as "this run is over", so it stops waiting.
    return encoder.encode(RunErrorEvent(type=EventType.RUN_ERROR, message=message, code=code))


async def _append(run_id: str, encoded: str) -> None:
    # The next number is computed in the INSERT itself.
    await _query(
        """INSERT INTO agent_run_events (run_id, seq, event)
           SELECT %s, coalesce(max(seq), 0) + 1, %s FROM agent_run_events WHERE run_id = %s""",
        (run_id, encoded, run_id),
    )


async def _finish(run_id: str) -> None:
    await _query("UPDATE agent_runs SET status = 'finished' WHERE run_id = %s", (run_id,))


# --- Used by the API (main.py) ------------------------------------------------


async def enqueue_run(input: RunAgentInput) -> None:
    """Put the run in the queue; a worker picks it up within POLL_SECONDS."""
    await _query(
        f"DELETE FROM agent_runs WHERE status = 'finished' AND created_at < now() - interval '{KEEP_FINISHED}'"
    )
    await _query(
        """INSERT INTO agent_runs (run_id, thread_id, status, input)
           VALUES (%s, %s, 'queued', %s) ON CONFLICT DO NOTHING""",
        (input.run_id, input.thread_id, Jsonb(input.model_dump(mode="json", by_alias=True))),
    )


async def run_exists(run_id: str) -> bool:
    return bool(await _query("SELECT 1 FROM agent_runs WHERE run_id = %s", (run_id,)))


async def read(run_id: str, after: int) -> AsyncIterator[str]:
    """Yield SSE events numbered after `after` (0 = from the start), then wait
    for new ones until the run is finished."""
    position = after
    while True:
        # Status first, then events: a run is marked finished only after its
        # last event is saved, so "finished + no new events" means done.
        status = await _query("SELECT status FROM agent_runs WHERE run_id = %s", (run_id,))
        if not status:
            return
        rows = await _query(
            "SELECT seq, event FROM agent_run_events WHERE run_id = %s AND seq > %s ORDER BY seq",
            (run_id, position),
        )
        for seq, event in rows:
            position = seq
            yield f"id: {seq}\n{event}"
        if status[0][0] == "finished" and not rows:
            return
        if not rows:
            await asyncio.sleep(POLL_SECONDS)


async def active_run(thread_id: str) -> str | None:
    """The run still queued or being written for this thread, if any."""
    rows = await _query(
        """SELECT run_id FROM agent_runs WHERE thread_id = %s AND status IN ('queued', 'running')
           ORDER BY created_at DESC LIMIT 1""",
        (thread_id,),
    )
    return rows[0][0] if rows else None


async def latest_run(thread_id: str) -> str | None:
    """The thread's most recent run, e.g. the one a pending approval paused."""
    rows = await _query(
        "SELECT run_id FROM agent_runs WHERE thread_id = %s ORDER BY created_at DESC LIMIT 1", (thread_id,)
    )
    return rows[0][0] if rows else None


async def cancel_run(thread_id: str) -> bool:
    """Stop the thread's run. A queued one is closed right away; a running one is
    stopped by its worker, which checks the flag with every heartbeat."""
    rows = await _query(
        """UPDATE agent_runs SET cancel_requested = true
           WHERE thread_id = %s AND status IN ('queued', 'running') RETURNING run_id, status""",
        (thread_id,),
    )
    for run_id, status in rows:
        if status == "queued":
            closed = await _query(
                "UPDATE agent_runs SET status = 'finished' WHERE run_id = %s AND status = 'queued' RETURNING 1",
                (run_id,),
            )
            if closed:
                await _append(run_id, _error("Stopped.", "cancelled"))
    return bool(rows)


def parse_offset(value: str | None) -> int:
    """TanStack sends "-1" for "from the start"; otherwise the last id it saw."""
    try:
        return max(int(value or 0), 0)
    except ValueError:
        return 0


# --- Used by workers (worker.py) ----------------------------------------------


async def claim_next() -> tuple | None:
    """Take one run to work on: a queued one, or a running one whose worker died
    (heartbeat silent too long). SKIP LOCKED lets many workers poll at once
    without two of them taking the same run."""
    rows = await _query(
        f"""UPDATE agent_runs
            SET status = 'running', heartbeat_at = now(), attempts = attempts + 1
            WHERE run_id = (
              SELECT run_id FROM agent_runs
              WHERE status = 'queued'
                 OR (status = 'running' AND heartbeat_at < now() - interval '{HEARTBEAT_DEAD_SECONDS} seconds')
              ORDER BY created_at
              FOR UPDATE SKIP LOCKED
              LIMIT 1
            )
            RETURNING run_id, thread_id, input, attempts, cancel_requested"""
    )
    return rows[0] if rows else None


async def drive_run(
    agent: LangGraphAgent, job: tuple, after_run: Callable[[str], Awaitable[None]] | None = None
) -> None:
    """Run one claimed run and save its events, until it ends or is stopped."""
    run_id, thread_id, input_json, attempts, cancel_requested = job
    if attempts > MAX_ATTEMPTS:
        await _append(run_id, _error(f"The reply failed after {MAX_ATTEMPTS} attempts.", "failed"))
        return await _finish(run_id)
    if cancel_requested:
        await _append(run_id, _error("Stopped.", "cancelled"))
        return await _finish(run_id)

    input = RunAgentInput.model_validate(input_json)
    me = asyncio.current_task()
    stop_requested = False

    async def heartbeat() -> None:
        # Tells other workers this run is alive, and picks up a Stop request.
        nonlocal stop_requested
        while True:
            await asyncio.sleep(HEARTBEAT_SECONDS)
            rows = await _query(
                "UPDATE agent_runs SET heartbeat_at = now() WHERE run_id = %s RETURNING cancel_requested",
                (run_id,),
            )
            if rows and rows[0][0]:
                stop_requested = True
                me.cancel()

    beat = asyncio.create_task(heartbeat())
    try:
        async with asyncio.timeout(RUN_TIMEOUT_SECONDS):
            # A fresh copy per run: the agent keeps per-run state on itself.
            async for event in agent.clone().run(input):
                # The adapter ends each run with a MESSAGES_SNAPSHOT, and TanStack
                # replaces its messages with it. The snapshot leaves out Gemini's
                # reasoning, so the reasoning shown live would vanish. Its ids
                # match the streamed ones, so dropping it loses nothing.
                if event.type == EventType.MESSAGES_SNAPSHOT:
                    continue
                # A retry after a crash: the log already started this run.
                if attempts > 1 and event.type == EventType.RUN_STARTED:
                    continue
                await _append(run_id, encoder.encode(event))
    except TimeoutError:
        await _append(run_id, _error(f"The reply took longer than {RUN_TIMEOUT_SECONDS:.0f} s and was stopped.", "timeout"))
    except asyncio.CancelledError:
        if not stop_requested:
            # The worker itself is shutting down: leave the run 'running' so its
            # heartbeat goes quiet and another worker picks it up.
            beat.cancel()
            raise
        await _append(run_id, _error("Stopped.", "cancelled"))
    except Exception as error:  # surface the failure to the page instead of hanging
        await _append(run_id, _error(str(error), "error"))
    beat.cancel()
    if after_run:
        try:
            await after_run(thread_id)
        except Exception as error:
            await _append(run_id, _error(f"Cleanup after the reply failed: {error}", "error"))
    await _finish(run_id)
