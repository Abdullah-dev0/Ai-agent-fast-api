"""Turn a LangGraph thread into the chat the page shows after a reload.

The messages are AI SDK UIMessages, the same shape useChat builds from the live
stream (ui_stream.py), so a reloaded chat looks the same as a live one:

    { id, role: "user" | "assistant", parts: [...] }

One assistant message per reply: the AI messages and tool results between two
user messages are merged into it, in order. Parts:

    { type: "text", text, state: "done" }
    { type: "dynamic-tool", toolCallId, toolName, input, state, ... }
        state "output-available" with `output`; "output-error" with `errorText`
        (the tool failed, or the user denied it); "approval-requested" with
        `approval` (still waiting for the user); "input-available" (never ran,
        e.g. the reply was stopped)

No reasoning parts: the page shows reasoning only as "Thought for 4s", timed while
it streams, and a saved chat has no timing to show (nor is the text ever sent).
"""

from langchain.messages import AIMessage, AnyMessage, HumanMessage, ToolMessage

from ui_stream import text_of


def tool_part(call: dict, result: ToolMessage | None, interrupt) -> dict:
    part = {"type": "dynamic-tool", "toolCallId": call["id"], "toolName": call["name"], "input": call["args"]}
    if result is not None and result.status == "error":
        part.update(state="output-error", errorText=text_of(result.content))
    elif result is not None:
        part.update(state="output-available", output=text_of(result.content))
    elif interrupt is not None:
        # Same as a live tool-approval-request (ui_stream.py).
        part.update(state="approval-requested", approval={"id": interrupt.id, "requestReason": interrupt.value.get("description", "")})
    else:
        part.update(state="input-available")
    return part


def to_ui_messages(messages: list[AnyMessage], interrupts: list) -> list[dict]:
    # A tool's result is its own message in LangGraph; on the page it belongs on
    # the tool call that asked for it.
    results = {m.tool_call_id: m for m in messages if isinstance(m, ToolMessage)}
    waiting = {i.value["tool_call_id"]: i for i in interrupts if isinstance(i.value, dict) and "tool_call_id" in i.value}
    ui: list[dict] = []
    for m in messages:
        if isinstance(m, HumanMessage):
            ui.append({"id": m.id, "role": "user", "parts": [{"type": "text", "text": text_of(m.content)}]})
        elif isinstance(m, AIMessage):
            if not ui or ui[-1]["role"] != "assistant":
                ui.append({"id": m.id, "role": "assistant", "parts": []})
            parts = ui[-1]["parts"]
            # Text first, as it streams: a model call's tool calls are sent at its end.
            if text := text_of(m.content):
                parts.append({"type": "text", "text": text, "state": "done"})
            for call in m.tool_calls:
                parts.append(tool_part(call, results.get(call["id"]), waiting.get(call["id"])))
    return [m for m in ui if m["parts"]]
