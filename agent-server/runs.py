"""Replies that survive a page refresh, written by hand to match TanStack's protocol.

The idea:
1. The agent runs in a background task, not inside the HTTP response, so it
   keeps going when the browser disconnects (a refresh, a closed tab).
2. Every event it produces is saved in Postgres (agent_run_events), numbered
   1, 2, 3... (tables in db/migrations/0003_agent_run_log.sql).
3. Any request on any server can read a run from a position onwards: the
   original POST, a reconnect (Last-Event-ID header), or a reloaded page
   rejoining (GET ?runId=).

Each event goes out as "id: <number>" + "data: <event>". TanStack remembers the
last id it saw and sends it back when it reconnects, so we know where to resume.

Because the log is in Postgres, a server restart keeps everything written so
far. The reply itself cannot continue (the agent ran inside that server), so a
run whose heartbeat stops is closed with an error and the page shows the
partial reply instead of waiting forever.
"""

import asyncio
import os
from collections.abc import AsyncIterator, Awaitable, Callable

from ag_ui.core import EventType, RunAgentInput, RunErrorEvent
from ag_ui.encoder import EventEncoder
from ag_ui_langgraph import LangGraphAgent
from psycopg_pool import AsyncConnectionPool

# The most one run may take, all model and tool calls included. Past this it is
# stopped, so a stuck reply cannot stay "running" (and costing) forever.
RUN_TIMEOUT_SECONDS = float(os.environ.get("AGENT_RUN_TIMEOUT_SECONDS", "120"))
# A running reply refreshes its heartbeat this often; one silent for longer
# than HEARTBEAT_DEAD_SECONDS belonged to a server that crashed or restarted.
HEARTBEAT_SECONDS = 2
HEARTBEAT_DEAD_SECONDS = 30
# Readers on another server have no direct signal, so they look for new
# events this often. Readers on the same server are woken right away.
POLL_SECONDS = 0.5
# Finished runs are deleted after this long; their messages are already in
# the agent's own memory (the LangGraph checkpointer).
KEEP_FINISHED = "1 hour"

encoder = EventEncoder(accept="text/event-stream")
_pool: AsyncConnectionPool | None = None
_after_run: Callable[[str], Awaitable[None]] | None = None
_tasks: dict[str, asyncio.Task] = {}  # runs driven by this server (also keeps tasks alive)
_wake: dict[str, asyncio.Event] = {}  # wakes this server's readers when an event is saved


def init(pool: AsyncConnectionPool, after_run: Callable[[str], Awaitable[None]] | None = None) -> None:
    """`after_run(thread_id)` runs when a reply ends, before it is marked finished."""
    global _pool, _after_run
    _pool, _after_run = pool, after_run


async def _query(sql: str, params: tuple = ()) -> list[tuple]:
    assert _pool is not None, "runs.init(pool) was not called"
    async with _pool.connection() as conn:
        cursor = await conn.execute(sql, params)
        return await cursor.fetchall() if cursor.description else []


def _wake_readers(run_id: str) -> None:
    if event := _wake.get(run_id):
        event.set()


def _error(message: str, code: str) -> str:
    # The page reads RUN_ERROR as "this run is over", so it stops waiting.
    return encoder.encode(RunErrorEvent(type=EventType.RUN_ERROR, message=message, code=code))


async def _append(run_id: str, encoded: str) -> None:
    # The next number is computed in the INSERT itself, so a dead-run close
    # from another server can never take the same number.
    await _query(
        """INSERT INTO agent_run_events (run_id, seq, event)
           SELECT %s, coalesce(max(seq), 0) + 1, %s FROM agent_run_events WHERE run_id = %s""",
        (run_id, encoded, run_id),
    )
    _wake_readers(run_id)


async def _finish(run_id: str) -> None:
    await _query("UPDATE agent_runs SET status = 'finished' WHERE run_id = %s", (run_id,))
    _wake_readers(run_id)


async def start_run(agent: LangGraphAgent, input: RunAgentInput) -> None:
    """Record the run, then start the agent in the background to fill its log."""
    await _query(
        f"DELETE FROM agent_runs WHERE status = 'finished' AND created_at < now() - interval '{KEEP_FINISHED}'"
    )
    await _query(
        "INSERT INTO agent_runs (run_id, thread_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
        (input.run_id, input.thread_id),
    )

    async def heartbeat(task: asyncio.Task) -> None:
        # Tells other servers this run is alive, and picks up a Stop request
        # made on any server.
        while True:
            await asyncio.sleep(HEARTBEAT_SECONDS)
            rows = await _query(
                "UPDATE agent_runs SET heartbeat_at = now() WHERE run_id = %s RETURNING cancel_requested",
                (input.run_id,),
            )
            if rows and rows[0][0]:
                task.cancel()

    async def drive() -> None:
        beat = asyncio.create_task(heartbeat(asyncio.current_task()))
        try:
            async with asyncio.timeout(RUN_TIMEOUT_SECONDS):
                # A fresh copy per run: the agent keeps per-run state on itself.
                async for event in agent.clone().run(input):
                    await _append(input.run_id, encoder.encode(event))
        except TimeoutError:
            await _append(input.run_id, _error(f"The reply took longer than {RUN_TIMEOUT_SECONDS:.0f} s and was stopped.", "timeout"))
        except asyncio.CancelledError:
            # cancel_run() or a Stop picked up by the heartbeat. We started this
            # task ourselves, so we end it cleanly here instead of re-raising.
            await _append(input.run_id, _error("Stopped.", "cancelled"))
        except Exception as error:  # surface the failure to the page instead of hanging
            await _append(input.run_id, _error(str(error), "error"))
        finally:
            beat.cancel()
            if _after_run:
                try:
                    await _after_run(input.thread_id)
                except Exception as error:
                    await _append(input.run_id, _error(f"Cleanup after the reply failed: {error}", "error"))
            await _finish(input.run_id)
            _tasks.pop(input.run_id, None)

    _tasks[input.run_id] = asyncio.create_task(drive())


async def run_exists(run_id: str) -> bool:
    return bool(await _query("SELECT 1 FROM agent_runs WHERE run_id = %s", (run_id,)))


async def _close_if_dead(run_id: str) -> None:
    """A run still marked running whose heartbeat stopped: its server is gone.
    Close it with an error so readers (and reloaded pages) stop waiting."""
    rows = await _query(
        f"""UPDATE agent_runs SET status = 'finished'
            WHERE run_id = %s AND status = 'running'
              AND heartbeat_at < now() - interval '{HEARTBEAT_DEAD_SECONDS} seconds'
            RETURNING run_id""",
        (run_id,),
    )
    if rows:
        await _append(run_id, _error("The server restarted before the reply finished.", "server_restarted"))


async def read(run_id: str, after: int) -> AsyncIterator[str]:
    """Yield SSE events numbered after `after` (0 = from the start), then wait
    for new ones until the run is finished."""
    wake = _wake.setdefault(run_id, asyncio.Event())
    position = after
    try:
        while True:
            wake.clear()
            # Status first, then events: a run marks itself finished only after
            # saving its last event, so "finished + no new events" means done.
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
                await _close_if_dead(run_id)
                try:
                    await asyncio.wait_for(wake.wait(), POLL_SECONDS)
                except TimeoutError:
                    pass
    finally:
        if run_id not in _tasks:
            _wake.pop(run_id, None)


async def active_run(thread_id: str) -> str | None:
    """The run still being written for this thread, if any (after closing dead ones)."""
    rows = await _query(
        "SELECT run_id FROM agent_runs WHERE thread_id = %s AND status = 'running' ORDER BY created_at DESC",
        (thread_id,),
    )
    for (run_id,) in rows:
        await _close_if_dead(run_id)
    rows = await _query(
        "SELECT run_id FROM agent_runs WHERE thread_id = %s AND status = 'running' ORDER BY created_at DESC LIMIT 1",
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
    """Stop the thread's running reply, on whichever server runs it. Returns
    False if nothing was running."""
    rows = await _query(
        "UPDATE agent_runs SET cancel_requested = true WHERE thread_id = %s AND status = 'running' RETURNING run_id",
        (thread_id,),
    )
    for (run_id,) in rows:
        if task := _tasks.get(run_id):
            task.cancel()  # ours: stop now; another server's heartbeat picks up the flag
    return bool(rows)


def parse_offset(value: str | None) -> int:
    """TanStack sends "-1" for "from the start"; otherwise the last id it saw."""
    try:
        return max(int(value or 0), 0)
    except ValueError:
        return 0
