"""Turn a LangGraph thread into the chat the page shows after a reload.

The shape matches what the page's useAgentChat hook builds from the live
stream, so a reloaded chat looks the same as a live one:

    { id, role: "user" | "assistant", parts: [...], usage?: { input, output } }

One assistant entry per reply: the AI messages and tool results between two
user messages are merged into it, in order. Parts:

    { type: "text", id, text }
    { type: "reasoning", id }   (that the model thought; its text stays here)
    { type: "tool", id, name, args, result?, failed? }   (no result: not run yet;
        failed: the result has status "error", e.g. the user denied the call)
"""

import json

from langchain.messages import AIMessage, AnyMessage, HumanMessage, ToolMessage


def text_of(content) -> str:
    """Message text, whether LangChain stored it as a string or a list of parts."""
    if isinstance(content, str):
        return content
    return "".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")


def thoughts_of(message: AIMessage) -> list[str]:
    """The model's reasoning, whichever model wrote it. Each provider saves it in its
    own shape (Gemini and Claude as "thinking" blocks, OpenAI as "reasoning" blocks);
    LangChain's content_blocks turns them all into {"type": "reasoning", "reasoning": ...}.
    OpenRouter has no translator there and keeps it in additional_kwargs."""
    thoughts = [
        b["reasoning"] for b in message.content_blocks if b.get("type") == "reasoning" and b.get("reasoning")
    ]
    if not thoughts and (reasoning := message.additional_kwargs.get("reasoning_content")):
        return [reasoning]
    return thoughts


def to_ui_messages(messages: list[AnyMessage]) -> list[dict]:
    # A tool's result is its own message in LangGraph; on the page it belongs on
    # the tool call that asked for it.
    results = {m.tool_call_id: m for m in messages if isinstance(m, ToolMessage)}
    ui: list[dict] = []
    for m in messages:
        if isinstance(m, HumanMessage):
            ui.append({"id": m.id, "role": "user", "parts": [{"type": "text", "id": m.id, "text": text_of(m.content)}]})
        elif isinstance(m, AIMessage):
            if not ui or ui[-1]["role"] != "assistant":
                ui.append({"id": m.id, "role": "assistant", "parts": []})
            parts = ui[-1]["parts"]
            # Reasoning first, as it streamed. Only that it happened: like the live
            # stream (main.py), the text stays on the server.
            parts += [{"type": "reasoning", "id": f"{m.id}-reasoning-{i}"} for i in range(len(thoughts_of(m)))]
            for call in m.tool_calls:
                part = {"type": "tool", "id": call["id"], "name": call["name"], "args": json.dumps(call["args"])}
                if (result := results.get(call["id"])) is not None:
                    part["result"] = text_of(result.content)
                    if result.status == "error":
                        part["failed"] = True
                parts.append(part)
            if text := text_of(m.content):
                parts.append({"type": "text", "id": m.id, "text": text})
            # One reply can be several model calls (a tool round trip): add them up,
            # as the live RUN_FINISHED does. No usage reported: no "usage" key.
            if m.usage_metadata:
                usage = ui[-1].setdefault("usage", {"input": 0, "output": 0})
                usage["input"] += m.usage_metadata.get("input_tokens", 0)
                usage["output"] += m.usage_metadata.get("output_tokens", 0)
    return [m for m in ui if m["parts"]]
