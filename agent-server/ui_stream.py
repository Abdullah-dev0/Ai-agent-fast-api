"""Turns one LangGraph run into the AI SDK's UI message stream: what the page's
useChat reads (https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol).

The stream is Server-Sent Events, one JSON chunk per `data:` line, ended by
`data: [DONE]`. The chunks this server sends:

    start / finish                       one reply
    text-start, text-delta, text-end     the reply's text, per model call
    reasoning-start, reasoning-end       that the model thought (never what: the
                                         text stays here, like ChatGPT). The end
                                         carries how long, for "Thought for 4s".
    tool-input-start, tool-input-available
                                         a tool call, once the model call is done
                                         (Gemini sends a call's arguments all at once)
    tool-output-available / -error / -denied
                                         its result
    tool-approval-request                the run paused: this call needs the user's OK
    data-context                         how full the model's context is (transient:
                                         not kept in the message)
    error                                the reply failed

Tool parts are "dynamic": the page does not know the tools' types, only their names.
"""

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator
from typing import Any

from langchain.messages import AIMessage, HumanMessage, ToolMessage

logger = logging.getLogger(__name__)

# The header that tells useChat this is a UI message stream.
HEADERS = {"x-vercel-ai-ui-message-stream": "v1", "Cache-Control": "no-cache"}

# What the page shows when a reply fails. The real error (a Python exception, a
# provider error) goes to the server log, not to the user.
REPLY_FAILED = "Something went wrong with that reply. Try again."


def sse(chunk: dict) -> str:
    return f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"


def text_of(content) -> str:
    """Message text, whether LangChain stored it as a string or a list of parts."""
    if isinstance(content, str):
        return content
    # A list mixes text blocks with plain strings when a streamed reply had both.
    return "".join(
        p if isinstance(p, str) else p.get("text", "")
        for p in content
        if isinstance(p, str) or (isinstance(p, dict) and p.get("type") == "text")
    )


# Where providers put reasoning in a streamed chunk's content: LangChain's standard
# block ("reasoning"), the older Anthropic/Gemini one ("thinking") and Bedrock's.
REASONING_BLOCKS = {"reasoning", "thinking", "reasoning_content"}


def split_chunk(chunk) -> tuple[str, bool]:
    """The text in one streamed model chunk, and whether it carries reasoning."""
    content = chunk.content
    if isinstance(content, str):
        reasoning = bool(chunk.additional_kwargs.get("reasoning_content") or chunk.additional_kwargs.get("reasoning"))
        return content, reasoning
    blocks = [b for b in content if isinstance(b, dict)]
    return text_of(blocks), any(b.get("type") in REASONING_BLOCKS for b in blocks)


def tool_output(message: ToolMessage, denied: bool = False) -> dict:
    """The chunk for a tool's result. A failure's text is written for the model (why
    it did not run), so the page only shows that the step did not happen."""
    if denied:
        return {"type": "tool-output-denied", "toolCallId": message.tool_call_id}
    if message.status == "error":
        return {"type": "tool-output-error", "toolCallId": message.tool_call_id, "errorText": text_of(message.content)}
    return {"type": "tool-output-available", "toolCallId": message.tool_call_id, "output": text_of(message.content), "dynamic": True}


class Reply:
    """What this stream has sent so far, so each part opens and closes once."""

    def __init__(self, resumed: set[str]):
        self.text_id: str | None = None  # the open text part
        self.reasoning: tuple[str, float] | None = None  # the open reasoning part, and when it started
        self.reasonings = 0
        # Tool calls the page has a part for: sent by this stream, or answered approvals
        # (their parts came from an earlier stream or the saved chat).
        self.calls: set[str] = set(resumed)
        self.outputs: set[str] = set()

    def close_text(self):
        if self.text_id is not None:
            yield {"type": "text-end", "id": self.text_id}
            self.text_id = None

    def close_reasoning(self):
        if self.reasoning is not None:
            part_id, started = self.reasoning
            # At least 1s, so a quick thought still reads right.
            seconds = max(1, round(time.monotonic() - started))
            yield {"type": "reasoning-end", "id": part_id, "providerMetadata": {"aragon": {"seconds": seconds}}}
            self.reasoning = None

    def text(self, part_id: str, delta: str):
        yield from self.close_reasoning()
        if self.text_id != part_id:
            yield from self.close_text()
            yield {"type": "text-start", "id": part_id}
            self.text_id = part_id
        yield {"type": "text-delta", "id": part_id, "delta": delta}

    def on_event(self, event: dict[str, Any]):
        kind = event["event"]
        if kind == "on_chat_model_stream":
            text, reasoning = split_chunk(event["data"]["chunk"])
            if reasoning and self.reasoning is None:
                yield from self.close_text()
                self.reasonings += 1
                part_id = f"reasoning-{event['run_id']}-{self.reasonings}"
                self.reasoning = (part_id, time.monotonic())
                yield {"type": "reasoning-start", "id": part_id}
            if text:
                yield from self.text(f"text-{event['run_id']}", text)
        elif kind == "on_chat_model_end":
            yield from self.close_reasoning()
            yield from self.close_text()
            output = event["data"].get("output")
            for call in output.tool_calls if isinstance(output, AIMessage) else []:
                self.calls.add(call["id"])
                base = {"toolCallId": call["id"], "toolName": call["name"], "dynamic": True}
                yield {"type": "tool-input-start", **base}
                yield {"type": "tool-input-available", **base, "input": call["args"]}
        elif kind == "on_tool_end":
            output = event["data"].get("output")
            if isinstance(output, ToolMessage) and output.tool_call_id in self.calls:
                self.outputs.add(output.tool_call_id)
                yield tool_output(output)
        elif kind == "on_custom_event":
            if event["name"] == "context_usage":
                yield {"type": "data-context", "data": event["data"], "transient": True}
            elif event["name"] == "fixed_reply":
                # A reply made without the model (agent.py answer_without_model).
                yield from self.text(f"text-{event['data']['message_id']}", event["data"]["text"])
                yield from self.close_text()

    def after_run(self, state, denied: set[str]):
        """What only the saved state knows once the run has stopped: results that were
        never streamed (a denied call gets its answer without running), and the
        approvals the run is now waiting for."""
        yield from self.close_reasoning()
        yield from self.close_text()
        messages = state.values.get("messages", [])
        start = max((i for i, m in enumerate(messages) if isinstance(m, HumanMessage)), default=-1)
        for m in messages[start + 1 :]:
            if isinstance(m, ToolMessage) and m.tool_call_id in self.calls and m.tool_call_id not in self.outputs:
                self.outputs.add(m.tool_call_id)
                yield tool_output(m, denied=m.tool_call_id in denied)
        for interrupt in pending_interrupts(state):
            value = interrupt.value
            if isinstance(value, dict) and value.get("type") == "tool_approval" and value["tool_call_id"] in self.calls:
                yield {
                    "type": "tool-approval-request",
                    "approvalId": interrupt.id,
                    "toolCallId": value["tool_call_id"],
                    # What the approval card says: JSON for the account tools (_card in
                    # account_tools.py), a sentence for the delete tool.
                    "reason": value.get("description", ""),
                }


def pending_interrupts(state) -> list:
    """The interrupts a paused thread waits on: one per tool call that needs approval."""
    return [i for task in state.tasks for i in task.interrupts]


async def stream_reply(graph, graph_input, config, *, resumed: set[str] = frozenset(), denied: set[str] = frozenset()) -> AsyncIterator[str]:
    """Runs the graph and yields the reply as UI message stream lines.

    resumed: the tool calls whose approvals this run answers. denied: those of them
    the user denied. Closing the request cancels this generator, which stops the run.
    """
    reply = Reply(set(resumed))
    yield sse({"type": "start"})
    try:
        async for event in graph.astream_events(graph_input, config, version="v2"):
            for chunk in reply.on_event(event):
                yield sse(chunk)
        state = await graph.aget_state(config)
        for chunk in reply.after_run(state, set(denied)):
            yield sse(chunk)
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("Agent run failed")
        yield sse({"type": "error", "errorText": REPLY_FAILED})
    yield sse({"type": "finish"})
    yield "data: [DONE]\n\n"
