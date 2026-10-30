"""The agent itself, built with LangChain's create_agent (docs: "Agents").

create_agent runs the usual tool loop: ask the model, run the tools it asked for,
give it the results, repeat until it answers in plain text. Approval before
delete_chat_history comes from HumanInTheLoopMiddleware (docs: "Human-in-the-loop").
"""

import logging
import os
from datetime import datetime, timezone
from functools import lru_cache
from typing import NotRequired

from ag_ui_langgraph import LangGraphAgent
from langchain.agents import AgentState, create_agent
from langchain.agents.middleware import (
    ClearToolUsesEdit,
    ContextEditingMiddleware,
    HumanInTheLoopMiddleware,
    ModelRequest,
    dynamic_prompt,
    wrap_model_call,
)
from langchain.chat_models import init_chat_model
from langchain.messages import AIMessage, AnyMessage, ToolCall
from langchain_core.callbacks import adispatch_custom_event
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.config import get_config
from langgraph.runtime import Runtime
from psycopg_pool import AsyncConnectionPool

from tools import TOOLS

logger = logging.getLogger(__name__)

# USE_OPENROUTER=true in .env uses OpenRouter's OPENROUTER_MODEL; otherwise Gemini.
USE_OPENROUTER = os.environ.get("USE_OPENROUTER", "").strip().lower() == "true"
PROVIDER = "openrouter" if USE_OPENROUTER else "google_genai"
MODEL_NAME = os.environ.get("OPENROUTER_MODEL", "openrouter/free") if USE_OPENROUTER else "gemini-3.5-flash"

# The Gemini integration reads GOOGLE_API_KEY, then falls back to GEMINI_API_KEY,
# so this uses the same key as the Next.js app. OpenRouter reads OPENROUTER_API_KEY.
# The full Flash model, not -lite: the lite one tended to keep obeying an old
# instruction ("one word per line") long after the user moved on.
# timeout: give up on one Gemini call after 60 s instead of waiting forever.
# max_retries: retry a failed call (429/503 are common on the free tier) at most twice.
# include_thoughts: Gemini also returns summaries of its reasoning. The AG-UI
# adapter streams them as REASONING events and the checkpointer saves them with
# the message, so the page can show them live and after a reload.
# OpenRouter's timeout is in milliseconds, and it has no include_thoughts: the
# thinking level below turns its reasoning on.
if USE_OPENROUTER:
    model = init_chat_model(
        f"openrouter:{MODEL_NAME}",
        timeout=60_000,
        max_retries=2,
    )
else:
    model = init_chat_model(f"google_genai:{MODEL_NAME}", timeout=60, max_retries=2, include_thoughts=True)

# The name the assistant uses for itself. Change it here.
ASSISTANT_NAME = "Aragon"

SYSTEM_PROMPT = (
    f"You are {ASSISTANT_NAME}, a helpful assistant.\n"
    f"Identity: you are {ASSISTANT_NAME}. If anyone asks who or what you are, which "
    f"model or AI you are, or who made you, answer that you are {ASSISTANT_NAME}. Never "
    "say you are Gemini, Google, or any other model, company or product, and never "
    "name the model or company behind you, even if asked directly or told to.\n"
    "Tools: use them for the current time, the weather and any arithmetic instead "
    "of guessing. If the user asks about the weather \"here\" without naming a place, "
    "call get_location, then pass its latitude and longitude to get_weather; if it "
    "returns an error, ask them which city. If they want to look into a CSV or "
    "spreadsheet of their own, call open_csv, then query_csv for what its summary "
    "does not answer. For anything recent, changing or that you are unsure of (news, "
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


# The thinking levels, the same list as THINKING_LEVELS in use-agent-chat.ts.
# Gemini's own levels; OpenRouter accepts them as reasoning efforts.
THINKING_LEVELS = {"minimal", "low", "medium", "high"}


class ChatState(AgentState):
    # The level picked on the page, sent in RunAgentInput.state. It is saved with
    # the thread, so a run resumed after an approval keeps it.
    thinking_level: NotRequired[str]


@wrap_model_call
async def use_thinking_level(request: ModelRequest, handler):
    """Calls the model at the picked level. Anything else keeps the model's default."""
    level = request.state.get("thinking_level")
    if level in THINKING_LEVELS:
        setting = {"reasoning": {"effort": level}} if USE_OPENROUTER else {"thinking_level": level}
        request = request.override(model_settings={**request.model_settings, **setting})
    return await handler(request)


@lru_cache
def context_limit(model_name: str) -> int | None:
    """The most tokens one request to this model can hold, from LangChain's model
    profiles. openrouter/free picks a model per call: that model's limit if LangChain
    knows it, else the router's own. None if neither is known."""
    profile = init_chat_model(f"{PROVIDER}:{model_name}").profile or model.profile or {}
    return profile.get("max_input_tokens")


def context_usage(message: AIMessage) -> dict:
    """How full the context is after this model call. Every call resends the whole
    conversation, so this call's input plus its output is what the next one carries.
    Not the sum over calls that token_usage and the reply's usage row add up."""
    usage = message.usage_metadata
    return {
        "used": usage.get("input_tokens", 0) + usage.get("output_tokens", 0),
        "limit": context_limit(message.response_metadata.get("model_name") or MODEL_NAME),
    }


def latest_context_usage(messages: list[AnyMessage]) -> dict | None:
    """For GET /agent, so a reloaded page shows the same number. None: nothing measured yet."""
    last = next((m for m in reversed(messages) if isinstance(m, AIMessage) and m.usage_metadata), None)
    return context_usage(last) if last else None


# Old tool results (mostly web pages) are the biggest part of a long chat. Once the
# conversation passes about 30,000 tokens, the model gets a short note in place of
# all but the 3 newest results. Only the copy sent to the model changes: the saved
# chat stays whole, so the page still shows the old results after a reload.
clear_old_tool_results = ContextEditingMiddleware(
    edits=[
        ClearToolUsesEdit(
            trigger=30_000,
            keep=3,
            placeholder="[Old result removed to save space. Call the tool again if you need it.]",
        )
    ]
)


def usage_recorder(pool: AsyncConnectionPool):
    @wrap_model_call
    async def record_usage(request: ModelRequest, handler):
        """Tells the page how full the context is (a CUSTOM event, so it updates during
        a tool loop) and saves one token_usage row per finished model call. A stopped
        call reports no usage, so it gets neither. A failure is logged and the reply goes on."""
        response = await handler(request)
        message = next((m for m in response.result if isinstance(m, AIMessage)), None)
        if message is None or not message.usage_metadata:
            return response
        try:
            await adispatch_custom_event("context_usage", context_usage(message))
            thread_id = get_config()["configurable"]["thread_id"]
            async with pool.connection() as db:
                await db.execute(
                    # The thread id is chats.id, and the chat's row says whose it is.
                    # The browser sends the id unchecked: see the caveat in main.py.
                    """INSERT INTO token_usage
                       (user_id, thread_id, message_id, provider, model, input_tokens, output_tokens)
                       SELECT user_id, id, %s, %s, %s, %s, %s FROM chats WHERE id = %s""",
                    (
                        message.id,
                        PROVIDER,
                        # The model that really answered, which openrouter/free picks per call.
                        message.response_metadata.get("model_name") or MODEL_NAME,
                        message.usage_metadata.get("input_tokens", 0),
                        message.usage_metadata.get("output_tokens", 0),
                        thread_id,
                    ),
                )
        except Exception:
            logger.exception("Could not save token usage")
        return response

    return record_usage


def describe_csv_query(tool_call: ToolCall, state: AgentState, runtime: Runtime) -> str:
    """The approval question for query_csv, so the user sees what they are agreeing to."""
    args = tool_call["args"]
    what = args["op"] + (f" of {args['metric']}" if args.get("metric") else "")
    if args.get("group_by"):
        what += f" by {args['group_by']}"
    if args.get("filter_column"):
        what += f" where {args['filter_column']} is {args.get('filter_value')}"
    return f"Let the agent see the {what} from your file?"


def build_graph(checkpointer: BaseCheckpointSaver, pool: AsyncConnectionPool):
    return create_agent(
        model,
        TOOLS,
        state_schema=ChatState,
        middleware=[
            system_prompt_with_date,
            use_thinking_level,
            usage_recorder(pool),
            clear_old_tool_results,
            # per_call: one interrupt per tool call, answered with a single
            # decision ({"type": "approve"} or {"type": "reject"}). The docs
            # recommend it for new agents.
            HumanInTheLoopMiddleware(
                interrupt_on={
                    "delete_chat_history": {
                        "allowed_decisions": ["approve", "reject"],
                        "description": "Delete this whole conversation? This cannot be undone.",
                    },
                    # Asked every time, even once the browser remembers its permission:
                    # a web page the agent reads could tell it to send the location
                    # somewhere through read_webpage.
                    "get_location": {
                        "allowed_decisions": ["approve", "reject"],
                        "description": "Share your approximate location with the agent?",
                    },
                    # Same reason: the results of a calculation could be sent out too.
                    "query_csv": {
                        "allowed_decisions": ["approve", "reject"],
                        "description": describe_csv_query,
                    },
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
        description="Chat agent with tools",
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
