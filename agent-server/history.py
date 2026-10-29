"""Turn a LangGraph thread into the chat history TanStack's useChat expects.

With `persistence: true`, useChat loads a thread on page load with
GET <url>?threadId=... and expects { messages, interrupts }, where
each message is { id, role, parts }. LangGraph already saved the thread
(checkpointer); this file only changes its shape.
"""

import json

from langchain.messages import AIMessage, AnyMessage, HumanMessage, ToolMessage


def text_of(content) -> str:
    """Message text, whether LangChain stored it as a string or a list of parts."""
    if isinstance(content, str):
        return content
    return "".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")


def thoughts_of(content) -> list[str]:
    """Gemini's reasoning summaries (include_thoughts=True), saved on the message
    as {"type": "thinking", "thinking": "..."} blocks."""
    if isinstance(content, str):
        return []
    return [p["thinking"] for p in content if isinstance(p, dict) and p.get("type") == "thinking" and p.get("thinking")]


def to_ui_messages(messages: list[AnyMessage]) -> list[dict]:
    # A tool's result is its own message in LangGraph; in the UI it belongs on
    # the tool call that asked for it.
    results = {m.tool_call_id: text_of(m.content) for m in messages if isinstance(m, ToolMessage)}
    ui = []
    for m in messages:
        # The same ids as LangGraph, so when useChat sends the history back the
        # agent recognises these messages instead of adding them twice.
        if isinstance(m, HumanMessage):
            ui.append({"id": m.id, "role": "user", "parts": [{"type": "text", "content": text_of(m.content)}]})
        elif isinstance(m, AIMessage):
            # Reasoning first, as it streamed: TanStack's `thinking` parts.
            parts = [{"type": "thinking", "content": thought} for thought in thoughts_of(m.content)]
            for call in m.tool_calls:
                part = {
                    "type": "tool-call",
                    "id": call["id"],
                    "name": call["name"],
                    "arguments": json.dumps(call["args"]),
                    "state": "complete",
                }
                # No result yet (waiting for approval): leave `output` out, so the
                # page shows "Waiting for approval" instead of "Used ... null".
                if call["id"] in results:
                    part["output"] = results[call["id"]]
                parts.append(part)
            if text := text_of(m.content):
                parts.append({"type": "text", "content": text})
            if parts:
                ui.append({"id": m.id, "role": "assistant", "parts": parts})
    return ui
