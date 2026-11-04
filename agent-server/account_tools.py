"""Tools that change the signed-in user's own data: display name and monthly token limit.

The model never says whose data to change. Each tool finds the user from the chat
(chats.user_id for this thread_id), the same way usage_recorder in agent.py does, and
runs one fixed SQL statement. The model only supplies the new value. Both tools are
approval-gated in agent.py, and the approval card shows the real before and after.
"""

import json
import os

import psycopg
from langchain.tools import tool
from langgraph.config import get_config
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

# The same limits as parseBudget in lib/usage.ts. Keep the two in step.
MIN_BUDGET = 1_000
MAX_BUDGET = 10_000_000_000
MAX_NAME_LENGTH = 60


def clean_name(name: str) -> tuple[str | None, str | None]:
    """(name, None) when valid, or (None, why not). Spaces are collapsed and trimmed."""
    name = " ".join(name.split())
    if not name:
        return None, "The name cannot be empty."
    if len(name) > MAX_NAME_LENGTH:
        return None, f"The name can be at most {MAX_NAME_LENGTH} characters."
    return name, None


def check_limit(limit: int | None) -> str | None:
    """Why this monthly limit is not allowed, or None. None as the limit means 'no limit'."""
    if limit is None:
        return None
    if limit < MIN_BUDGET:
        return f"The smallest limit is {MIN_BUDGET:,} tokens."
    if limit > MAX_BUDGET:
        return f"The largest limit is {MAX_BUDGET:,} tokens."
    return None


def _result(changed: bool, message: str) -> str:
    """What a tool answers with: JSON, so the page reads `changed` instead of the wording.
    The page side is parseAccountResult in lib/agent-tools.ts."""
    return json.dumps({"changed": changed, "message": message}, ensure_ascii=False)


def _card(title: str, *details: str) -> str:
    """The text of an approval card: a title and detail lines, as JSON.
    The page side is parseApprovalCard in lib/agent-tools.ts."""
    return json.dumps({"title": title, "details": list(details)}, ensure_ascii=False)


def _thread_id() -> str:
    return get_config()["configurable"]["thread_id"]


def account_tools(pool: AsyncConnectionPool) -> list:
    @tool
    async def update_my_profile(name: str) -> str:
        """Change the signed-in user's display name (the name shown in the app's menu).
        Use it only when the user asks to change their own name. They must approve it first."""
        new_name, problem = clean_name(name)
        if problem:
            return _result(False, problem)
        async with pool.connection() as db:
            cursor = await db.execute(
                # One statement: find the user through this chat, then update that user only.
                # me.name is the name before the update.
                """WITH me AS (
                       SELECT u.id, u.name FROM "user" u JOIN chats c ON c.user_id = u.id WHERE c.id = %s)
                   UPDATE "user" SET name = %s, "updatedAt" = now()
                   FROM me WHERE "user".id = me.id
                   RETURNING me.name AS old_name""",
                (_thread_id(), new_name),
            )
            row = await cursor.fetchone()
        if row is None:
            return _result(False, "Could not find your account.")
        return _result(True, f"Display name changed from {row['old_name']!r} to {new_name!r}.")

    @tool
    async def set_token_budget(monthly_token_limit: int | None) -> str:
        """Set the signed-in user's monthly token limit, which stops the chat once this
        calendar month's tokens reach it. Pass null to remove the limit. Use it only when
        the user asks to change their own limit. They must approve it first."""
        problem = check_limit(monthly_token_limit)
        if problem:
            return _result(False, problem)
        async with pool.connection() as db:
            if monthly_token_limit is None:
                await db.execute(
                    "DELETE FROM usage_budgets WHERE user_id = (SELECT user_id FROM chats WHERE id = %s)",
                    (_thread_id(),),
                )
                # Nothing to delete is fine: the user had no limit.
                found = True
            else:
                cursor = await db.execute(
                    """INSERT INTO usage_budgets (user_id, monthly_token_limit)
                       SELECT user_id, %s FROM chats WHERE id = %s
                       ON CONFLICT (user_id) DO UPDATE
                         SET monthly_token_limit = EXCLUDED.monthly_token_limit, updated_at = now()""",
                    (monthly_token_limit, _thread_id()),
                )
                found = cursor.rowcount == 1
        if not found:
            return _result(False, "Could not find your account.")
        if monthly_token_limit is None:
            return _result(True, "The monthly token limit is removed.")
        return _result(True, f"The monthly token limit is now {monthly_token_limit:,} tokens.")

    return [update_my_profile, set_token_budget]


def _current(sql: str) -> dict | None:
    """One row for the current chat's user. A plain (blocking) connection, because
    HumanInTheLoopMiddleware calls its description function without await. It is one
    indexed lookup on localhost, once per approval."""
    with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as db:
        return db.execute(sql, (_thread_id(),)).fetchone()


def describe_profile_change(tool_call, state, runtime) -> str:
    """The text on the approval card: what changes, before and after."""
    new_name, _ = clean_name(str(tool_call["args"].get("name", "")))
    row = _current(
        """SELECT u.name FROM "user" u JOIN chats c ON c.user_id = u.id WHERE c.id = %s"""
    )
    old_name = row["name"] if row else "unknown"
    return _card("Change your display name", f"Name: {old_name} → {new_name}")


def describe_budget_change(tool_call, state, runtime) -> str:
    limit = tool_call["args"].get("monthly_token_limit")
    row = _current(
        """SELECT b.monthly_token_limit AS current_limit,
                  (SELECT coalesce(sum(t.input_tokens + t.output_tokens), 0) FROM token_usage t
                    WHERE t.user_id = c.user_id
                      AND t.created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS used
           FROM chats c LEFT JOIN usage_budgets b ON b.user_id = c.user_id
           WHERE c.id = %s"""
    )
    before = f"{row['current_limit']:,} tokens" if row and row["current_limit"] else "no limit"
    after = "no limit" if limit is None else f"{limit:,} tokens"
    details = [f"Limit: {before} → {after}"]
    used = int(row["used"]) if row else 0
    details.append(f"Used this month: {used:,} tokens")
    if limit is not None and used >= limit:
        details.append("You have already used this much, so chat stops as soon as you approve.")
    return _card("Change your monthly token limit", *details)


def needs_approval(request) -> bool:
    """Ask the user only for a valid change. An invalid one skips the approval, and the
    tool itself answers with the reason. Must give the same answer when the run resumes."""
    args = request.tool_call["args"]
    if request.tool_call["name"] == "update_my_profile":
        return clean_name(str(args.get("name", "")))[1] is None
    limit = args.get("monthly_token_limit")
    return (limit is None or isinstance(limit, int)) and check_limit(limit) is None
