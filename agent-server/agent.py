"""The agent itself, built with LangChain's create_agent (docs: "Agents").

create_agent runs the usual tool loop: ask Gemini, run the tools it asked for,
give it the results, repeat until it answers in plain text. Approval before
delete_chat_history comes from HumanInTheLoopMiddleware (docs: "Human-in-the-loop").
"""

from ag_ui.core import EventType
from ag_ui_langgraph import LangGraphAgent
from langchain.agents import create_agent
from langchain.agents.middleware import HumanInTheLoopMiddleware, wrap_tool_call
from langchain.chat_models import init_chat_model
from langchain.messages import ToolMessage
from langgraph.checkpoint.base import BaseCheckpointSaver

from tools import TOOLS

# The Gemini integration reads GOOGLE_API_KEY, then falls back to GEMINI_API_KEY,
# so this uses the same key as the Next.js app.
# The full Flash model, not -lite: the lite one tended to keep obeying an old
# instruction ("one word per line") long after the user moved on.
# timeout: give up on one Gemini call after 60 s instead of waiting forever.
# max_retries: retry a failed call (429/503 are common on the free tier) at most twice.
# include_thoughts: Gemini also returns summaries of its reasoning. The AG-UI
# adapter streams them as REASONING events and the checkpointer saves them with
# the message, so the page can show them live and after a reload.
model = init_chat_model("google_genai:gemini-3.5-flash", timeout=60, max_retries=2, include_thoughts=True)

SYSTEM_PROMPT = (
    "You are a helpful assistant. Use the tools for the current time, the weather "
    "and any arithmetic instead of guessing. If the user asks to delete or clear "
    "the chat, call delete_chat_history; the app asks them to confirm.\n"
    "Always answer the user's latest message. A formatting request (like 'one word "
    "per line' or 'only numbers') applies to the reply it was asked for, not to "
    "every later reply, unless the user says it should. If the user asks a new "
    "question, answer it normally."
)


@wrap_tool_call
async def tanstack_tool_ids(request, handler):
    """Save each tool result with the id TanStack gives it ("tool-<call id>").

    useChat sends the whole history back with every message, and the AG-UI
    adapter adds any message whose id it has not saved yet. With matching ids,
    tool results are not saved twice.
    """
    result = await handler(request)
    if isinstance(result, ToolMessage):
        result.id = f"tool-{request.tool_call['id']}"
    return result


def build_graph(checkpointer: BaseCheckpointSaver):
    return create_agent(
        model,
        TOOLS,
        system_prompt=SYSTEM_PROMPT,
        middleware=[
            # First, so it also renames the "rejected" result the next one returns.
            tanstack_tool_ids,
            # per_call: one interrupt per tool call, answered with a single
            # decision ({"type": "approve"} or {"type": "reject"}). The docs
            # recommend it for new agents.
            HumanInTheLoopMiddleware(
                interrupt_on={
                    "delete_chat_history": {
                        "allowed_decisions": ["approve", "reject"],
                        "description": "Delete this whole conversation? This cannot be undone.",
                    }
                },
                interrupt_mode="per_call",
            ),
        ],
        # Saves the conversation after every step, per thread_id (also needed
        # for interrupts: the paused run is resumed from the saved state).
        checkpointer=checkpointer,
    )


class ChatAgent(LangGraphAgent):
    """The AG-UI adapter, minus the MESSAGES_SNAPSHOT it sends at the end of a run.

    TanStack replaces its messages with that snapshot, and the snapshot leaves
    out Gemini's reasoning, so every reasoning section on the page vanished when
    a reply finished. Its ids match the streamed ones, so dropping it loses nothing.
    """

    async def run(self, input):
        async for event in super().run(input):
            if event.type != EventType.MESSAGES_SNAPSHOT:
                yield event


def build_agui_agent(graph) -> LangGraphAgent:
    """Wrap the graph so it streams AG-UI events (what TanStack's useChat reads)."""
    return ChatAgent(
        name="assistant",
        description="Gemini agent with tools",
        graph=graph,
        # RAW events copy LangGraph's internal events for debugging only and
        # are most of the bytes on the wire; the chat UI does not need them.
        emit_raw_events=False,
        # At most 12 graph steps per run (one tool round trip is 2), so a model
        # that keeps calling tools cannot loop forever. LangGraph's default is 25.
        config={"recursion_limit": 12},
        # When the agent pauses for approval, end the run with RUN_FINISHED
        # outcome "interrupt" and accept the answer in RunAgentInput.resume[]:
        # the standard AG-UI way, which TanStack reads.
        emit_interrupt_outcome=True,
        enable_legacy_on_interrupt_event=False,
    )
