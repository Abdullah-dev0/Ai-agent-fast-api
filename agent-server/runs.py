"""Replies that run in the background, so leaving the page does not stop them.

A reply is a task of its own, not part of the POST request that started it. The task
keeps every event it makes in a list. The POST response, and any page that comes
back later (GET /agent?runId=...), only read that list: from the start, then each
new event as it comes, until the run is over. One run per chat at a time.

In memory: a restart of the server loses the runs that are going. What they
finished stays saved in the checkpointer.
"""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable

from ag_ui.core import BaseEvent
from ag_ui.encoder import EventEncoder


class Run:
    def __init__(self, thread_id: str, run_id: str):
        self.thread_id = thread_id
        self.run_id = run_id
        self.events: list[BaseEvent] = []
        self.done = False
        self.task: asyncio.Task | None = None
        self._changed = asyncio.Condition()

    async def publish(self, event: BaseEvent) -> None:
        async with self._changed:
            self.events.append(event)
            self._changed.notify_all()

    async def finish(self) -> None:
        async with self._changed:
            self.done = True
            self._changed.notify_all()

    async def follow(self, encoder: EventEncoder) -> AsyncIterator[str]:
        """Every event so far, then each new one, until the run is over."""
        i = 0
        while True:
            while i < len(self.events):
                yield encoder.encode(self.events[i])
                i += 1
            if self.done:
                return
            async with self._changed:
                await self._changed.wait_for(lambda: len(self.events) > i or self.done)


# The run going in each chat. asyncio keeps only a weak reference to a task, so
# holding the run here also keeps its task alive.
_active: dict[str, Run] = {}


def active_run(thread_id: str) -> Run | None:
    return _active.get(thread_id)


def run_by_id(run_id: str) -> Run | None:
    return next((r for r in _active.values() if r.run_id == run_id), None)


def start(thread_id: str, run_id: str, work: Callable[[Run], Awaitable[None]]) -> Run:
    """Runs work(run) in the background. It publishes the run's events."""
    run = Run(thread_id, run_id)
    _active[thread_id] = run

    async def main() -> None:
        try:
            await work(run)
        finally:
            # Leave the list first: from here the checkpointer has the whole reply.
            if _active.get(thread_id) is run:
                del _active[thread_id]
            await run.finish()

    run.task = asyncio.create_task(main())
    return run


def stop(thread_id: str) -> bool:
    """The Stop button. Steps the run already finished stay saved."""
    run = _active.get(thread_id)
    if run is None or run.task is None:
        return False
    run.task.cancel()
    return True
