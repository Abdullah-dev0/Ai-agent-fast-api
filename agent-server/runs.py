"""Replies that survive a page refresh, written by hand to match TanStack's protocol.

The idea, in three parts:
1. The agent runs in a background task, not inside the HTTP response, so it
   keeps going when the browser disconnects (a refresh, a closed tab).
2. Every event it produces goes into a RunLog, numbered 1, 2, 3...
3. Any request can read a RunLog from a position onwards: the original POST,
   a reconnect (Last-Event-ID header), or a reloaded page rejoining (GET ?runId=).

Each event goes out as "id: <number>" + "data: <event>". TanStack remembers the
last id it saw and sends it back when it reconnects, so we know where to resume.

Logs live in this process's memory: a server restart mid-reply loses them.
"""

import asyncio
from collections.abc import AsyncIterator

from ag_ui.core import EventType, RunAgentInput, RunErrorEvent
from ag_ui.encoder import EventEncoder
from ag_ui_langgraph import LangGraphAgent

# How long a finished run's log is kept, so a page that reloads just as the
# reply ends can still replay it.
KEEP_FINISHED_SECONDS = 60


class RunLog:
    def __init__(self, thread_id: str):
        self.thread_id = thread_id
        self.events: list[str] = []  # encoded "data: ...\n\n" strings, in order
        self.done = False
        self._changed = asyncio.Condition()

    async def append(self, encoded: str) -> None:
        async with self._changed:
            self.events.append(encoded)
            self._changed.notify_all()

    async def finish(self) -> None:
        async with self._changed:
            self.done = True
            self._changed.notify_all()

    async def read(self, after: int) -> AsyncIterator[str]:
        """Yield SSE events numbered after `after` (0 = from the start), then
        wait for new ones until the run is done."""
        position = after
        while True:
            async with self._changed:
                await self._changed.wait_for(lambda: len(self.events) > position or self.done)
                new = self.events[position:]
                done = self.done
            for encoded in new:
                position += 1
                yield f"id: {position}\n{encoded}"
            if done and position >= len(self.events):
                return


runs: dict[str, RunLog] = {}  # run id -> its log
active: dict[str, str] = {}  # thread id -> the run id still being written
_tasks: set[asyncio.Task] = set()  # keeps background tasks from being garbage-collected


def start_run(agent: LangGraphAgent, input: RunAgentInput) -> RunLog:
    """Start the agent in the background and return the log it fills."""
    log = RunLog(input.thread_id)
    runs[input.run_id] = log
    active[input.thread_id] = input.run_id
    encoder = EventEncoder(accept="text/event-stream")

    async def drive() -> None:
        try:
            # A fresh copy per run: the agent keeps per-run state on itself.
            async for event in agent.clone().run(input):
                await log.append(encoder.encode(event))
        except Exception as error:  # surface the failure to the page instead of hanging
            await log.append(encoder.encode(RunErrorEvent(type=EventType.RUN_ERROR, message=str(error))))
        finally:
            await log.finish()
            if active.get(input.thread_id) == input.run_id:
                del active[input.thread_id]
            asyncio.get_running_loop().call_later(KEEP_FINISHED_SECONDS, runs.pop, input.run_id, None)

    task = asyncio.create_task(drive())
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return log


def parse_offset(value: str | None) -> int:
    """TanStack sends "-1" for "from the start"; otherwise the last id it saw."""
    try:
        return max(int(value or 0), 0)
    except ValueError:
        return 0
