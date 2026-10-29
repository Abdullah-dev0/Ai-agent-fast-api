"""The agent itself, built with LangGraph's Graph API like the LangGraph quickstart:

    START -> call_model --(model asked for tools?)--> run_tools -> call_model ...
                       |--(no, it answered)-------> END

The model node asks Gemini what to do next. If Gemini wants tools, the tool node
runs them and loops back so Gemini can read the results. When Gemini answers
in plain text, the graph ends.
"""

from typing import Literal

from langchain.chat_models import init_chat_model
from langchain.messages import SystemMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.types import interrupt

from tools import NEEDS_APPROVAL, TOOLS

# The Gemini integration reads GOOGLE_API_KEY, then falls back to GEMINI_API_KEY,
# so this uses the same key as the Next.js app.
# The full Flash model, not -lite: the lite one tended to keep obeying an old
# instruction ("one word per line") long after the user moved on.
# timeout: give up on one Gemini call after 60 s instead of waiting forever.
# max_retries: retry a failed call (429/503 are common on the free tier) at most twice.
# include_thoughts: Gemini also returns summaries of its reasoning. The AG-UI
# adapter streams them as REASONING events and the checkpointer saves them with
# the message, so the page can show them live and after a reload.
model = init_chat_model(
    "google_genai:gemini-3.5-flash", timeout=60, max_retries=2, include_thoughts=True
).bind_tools(TOOLS)
tools_by_name = {t.name: t for t in TOOLS}

# Threads whose user approved delete_chat_history; main.py deletes them once the
# reply ends.
threads_to_delete: set[str] = set()

SYSTEM_PROMPT = (
    "You are a helpful assistant. Use the tools for the current time, the weather "
    "and any arithmetic instead of guessing. If the user asks to delete or clear "
    "the chat, call delete_chat_history; the app asks them to confirm.\n"
    "Always answer the user's latest message. A formatting request (like 'one word "
    "per line' or 'only numbers') applies to the reply it was asked for, not to "
    "every later reply, unless the user says it should. If the user asks a new "
    "question, answer it normally."
)


async def call_model(state: MessagesState) -> dict:
    """Ask Gemini for the next step, given the whole conversation so far."""
    reply = await model.ainvoke([SystemMessage(SYSTEM_PROMPT), *state["messages"]])
    return {"messages": [reply]}


async def run_tools(state: MessagesState, config: RunnableConfig) -> dict:
    """Run every tool call from Gemini's last message and return the results."""
    results = []
    for call in state["messages"][-1].tool_calls:
        if call["name"] in NEEDS_APPROVAL:
            # Pause the run and ask the user. The run ends here with an
            # "interrupt" outcome; when the user answers, LangGraph re-runs this
            # node and interrupt() returns their answer. (So tool calls before
            # this one in the same message run again: keep those side-effect free.)
            answer = interrupt({
                "reason": "tool-approval",
                "message": NEEDS_APPROVAL[call["name"]],
                "toolCallId": call["id"],
            })
            if not (isinstance(answer, dict) and answer.get("approved")):
                results.append(ToolMessage(
                    content="The user did not approve this, so it was not done.",
                    tool_call_id=call["id"],
                    id=f"tool-{call['id']}",
                ))
                continue
            if call["name"] == "delete_chat_history":
                threads_to_delete.add(config["configurable"]["thread_id"])
        # Passing the whole tool call (not just its args) makes LangChain return a
        # ToolMessage. The AG-UI adapter only streams a TOOL_CALL_RESULT event for
        # ToolMessage outputs, and that event is what fills the result in the UI.
        message = await tools_by_name[call["name"]].ainvoke(call)
        # The id is the one TanStack gives a tool result ("tool-<call id>"). When
        # its useChat sends the history back, ids match and nothing is added twice.
        message.id = f"tool-{call['id']}"
        results.append(message)
    return {"messages": results}


def should_continue(state: MessagesState) -> Literal["run_tools", "__end__"]:
    """Loop to the tools if Gemini asked for any, otherwise finish."""
    return "run_tools" if state["messages"][-1].tool_calls else END


def build_graph(checkpointer: BaseCheckpointSaver):
    # MessagesState (LangGraph's built-in) merges messages by id. The quickstart
    # appends with operator.add instead, but the AG-UI adapter re-sends edited
    # messages with their old id, and appending would duplicate them.
    builder = StateGraph(MessagesState)
    builder.add_node("call_model", call_model)
    builder.add_node("run_tools", run_tools)
    builder.add_edge(START, "call_model")
    builder.add_conditional_edges("call_model", should_continue, ["run_tools", END])
    builder.add_edge("run_tools", "call_model")
    # The checkpointer saves the state after every step, per thread_id.
    return builder.compile(checkpointer=checkpointer)
