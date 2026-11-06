"""Turn a LangGraph thread into the chat the page shows after a reload.

The messages are in TanStack AI's UIMessage shape, what the page's useChat builds
from the live stream, so a reloaded chat looks the same as a live one:

    { id, role: "user" | "assistant", parts: [...] }

One assistant message per AI message, as in the live stream: TanStack builds one per
message id, and LangGraph gives every model call its own, so a reply with tool calls
is several assistant messages in a row (the page groups them: toTurns in
components/agent-chat.tsx). A tool result goes into the message that made the call,
as it does live. Parts:

    { type: "text", content }
    { type: "tool-call", id, name, arguments, state }
    { type: "tool-result", toolCallId, content, state }   state "error": the result is
        a failure, e.g. the user denied the call. No result part: the tool never ran.

No reasoning parts: its text never leaves the server.
"""

import json

from langchain.messages import AIMessage, AnyMessage, HumanMessage, ToolMessage


def text_of(content) -> str:
    """Message text, whether LangChain stored it as a string or a list of parts."""
    if isinstance(content, str):
        return content
    return "".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")


def to_ui_messages(messages: list[AnyMessage]) -> list[dict]:
    ui: list[dict] = []
    # The parts of the message that made each tool call, for its result to join.
    call_parts: dict[str, list[dict]] = {}
    for m in messages:
        if isinstance(m, HumanMessage):
            ui.append({"id": m.id, "role": "user", "parts": [{"type": "text", "content": text_of(m.content)}]})
        elif isinstance(m, AIMessage):
            parts: list[dict] = []
            if text := text_of(m.content):
                parts.append({"type": "text", "content": text})
            for call in m.tool_calls:
                parts.append(
                    {"type": "tool-call", "id": call["id"], "name": call["name"], "arguments": json.dumps(call["args"]), "state": "input-complete"}
                )
                call_parts[call["id"]] = parts
            ui.append({"id": m.id, "role": "assistant", "parts": parts})
        elif isinstance(m, ToolMessage) and m.tool_call_id in call_parts:
            state = "error" if m.status == "error" else "complete"
            call_parts[m.tool_call_id].append(
                {"type": "tool-result", "toolCallId": m.tool_call_id, "content": text_of(m.content), "state": state}
            )
    return [m for m in ui if m["parts"]]
