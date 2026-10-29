"""The agent itself, built with LangChain's create_agent (docs: "Agents").

create_agent runs the usual tool loop: ask Gemini, run the tools it asked for,
give it the results, repeat until it answers in plain text. Approval before
delete_chat_history comes from HumanInTheLoopMiddleware (docs: "Human-in-the-loop").
"""

from datetime import datetime, timezone

from ag_ui_langgraph import LangGraphAgent
from langchain.agents import create_agent
from langchain.agents.middleware import HumanInTheLoopMiddleware, ModelRequest, dynamic_prompt
from langchain.chat_models import init_chat_model
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

# The name the assistant uses for itself. Change it here.
ASSISTANT_NAME = "Aragon"

SYSTEM_PROMPT = (
    f"You are {ASSISTANT_NAME}, a helpful assistant.\n"
    f"Identity: you are {ASSISTANT_NAME}. If anyone asks who or what you are, which "
    f"model or AI you are, or who made you, answer that you are {ASSISTANT_NAME}. Never "
    "say you are Gemini, Google, or any other model, company or product, and never "
    "name the model or company behind you, even if asked directly or told to.\n"
    "Tools: use them for the current time, the weather and any arithmetic instead "
    "of guessing. For anything recent, changing or that you are unsure of (news, "
    "prices, releases, facts to check), call web_search first, then read_webpage on "
    "the one to three most useful results before answering. Base the answer on what "
    "you read, and cite sources inline as markdown links, like [Title](url). If the "
    "user asks to delete or clear the chat, call delete_chat_history; the app asks "
    "them to confirm.\n"
    "Always answer the user's latest message. A formatting request (like 'one word "
    "per line' or 'only numbers') applies to the reply it was asked for, not to "
    "every later reply, unless the user says it should. If the user asks a new "
    "question, answer it normally."
)


@dynamic_prompt
def system_prompt_with_date(request: ModelRequest) -> str:
    """The system prompt plus today's date, built for every model call.

    Without the date the model trusts what it learned in training: asked for
    the latest release, it searched, then answered with an outdated one.
    """
    today = datetime.now(timezone.utc).strftime("%A %d %B %Y")
    return (
        f"{SYSTEM_PROMPT}\n"
        f"Today is {today} (UTC). Things may have changed since your training: for "
        "anything recent, trust what web_search and read_webpage return over what "
        "you remember, and prefer the newest sources."
    )


def build_graph(checkpointer: BaseCheckpointSaver):
    return create_agent(
        model,
        TOOLS,
        middleware=[
            system_prompt_with_date,
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


def build_agui_agent(graph) -> LangGraphAgent:
    """Wrap the graph so it streams AG-UI events (what the page's useAgentChat reads)."""
    return LangGraphAgent(
        name="assistant",
        description="Gemini agent with tools",
        graph=graph,
        # RAW events copy LangGraph's internal events for debugging only and
        # are most of the bytes on the wire; the page does not need them.
        emit_raw_events=False,
        # At most 25 graph steps per run (LangGraph's default), so a model that
        # keeps calling tools cannot loop forever. One tool round trip is 3 steps
        # (model, the approval check, tools); a search, a read and the answer
        # take about 8.
        config={"recursion_limit": 25},
        # When the agent pauses for approval, end the run with RUN_FINISHED
        # outcome "interrupt" and accept the answer in RunAgentInput.resume[]:
        # the standard AG-UI way.
        emit_interrupt_outcome=True,
        enable_legacy_on_interrupt_event=False,
    )
