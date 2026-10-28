"""Turn a LangGraph thread into the chat history TanStack's useChat expects.

With `persistence: true`, useChat loads a thread on page load with
GET <url>?threadId=... and expects { messages, activeRun, interrupts }, where
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


def thinking_of(content) -> str:
    """The thought summary Gemini sent with a reply (include_thoughts in agent.py)."""
    if isinstance(content, str):
        return ""
    return "".join(p.get("thinking", "") for p in content if isinstance(p, dict) and p.get("type") == "thinking")


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
            # Thinking first, as it streamed: the model thinks, then calls tools or answers.
            parts = [{"type": "thinking", "content": t}] if (t := thinking_of(m.content)) else []
            parts += [
                {
                    "type": "tool-call",
                    "id": call["id"],
                    "name": call["name"],
                    "arguments": json.dumps(call["args"]),
                    "state": "complete",
                    "output": results.get(call["id"]),
                }
                for call in m.tool_calls
            ]
            if text := text_of(m.content):
                parts.append({"type": "text", "content": text})
            if parts:
                ui.append({"id": m.id, "role": "assistant", "parts": parts})
    return ui
