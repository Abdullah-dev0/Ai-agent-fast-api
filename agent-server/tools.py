"""The agent's tools: plain Python functions the model can decide to call.

The @tool decorator turns each function into something the model can see:
its name, its arguments (from the type hints) and what it does (from the
docstring). Write the docstring for the model, it is how it picks a tool.
"""

import ast
import json
import operator
import os
from datetime import datetime
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from langchain.tools import tool
from tavily import AsyncTavilyClient


@tool
def get_current_time(timezone: str) -> str:
    """Get the current date and time in an IANA timezone, e.g. "Asia/Karachi" or "Europe/London"."""
    try:
        now = datetime.now(ZoneInfo(timezone))
    except ZoneInfoNotFoundError:
        return f"Unknown timezone: {timezone}. Use an IANA name like Asia/Karachi."
    return now.strftime("%A %d %B %Y, %H:%M (%Z)")


@tool
async def get_weather(city: str) -> str:
    """Get the current weather for a city (temperature, wind and conditions)."""
    # Open-Meteo is free and needs no API key: first find the city, then its weather.
    async with httpx.AsyncClient(timeout=10) as client:
        geo = await client.get(
            "https://geocoding-api.open-meteo.com/v1/search",
            params={"name": city, "count": 1},
        )
        places = geo.json().get("results")
        if not places:
            return f"Could not find a city called {city}."
        place = places[0]
        weather = await client.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": place["latitude"],
                "longitude": place["longitude"],
                "current": "temperature_2m,wind_speed_10m,weather_code",
            },
        )
    now = weather.json()["current"]
    return (
        f"{place['name']}, {place.get('country', '')}: {now['temperature_2m']}°C, "
        f"wind {now['wind_speed_10m']} km/h, weather code {now['weather_code']} (WMO)."
    )


# Only these operators are allowed, so the model cannot run arbitrary Python.
_OPERATORS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Pow: operator.pow,
    ast.USub: operator.neg,
}


def _evaluate(node: ast.AST) -> float:
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in _OPERATORS:
        return _OPERATORS[type(node.op)](_evaluate(node.left), _evaluate(node.right))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _OPERATORS:
        return _OPERATORS[type(node.op)](_evaluate(node.operand))
    raise ValueError("Only numbers and + - * / ** are allowed.")


@tool
def calculate(expression: str) -> str:
    """Calculate a math expression with + - * / ** and brackets, e.g. "(12.5 * 4) / 3"."""
    try:
        return str(_evaluate(ast.parse(expression, mode="eval").body))
    except (ValueError, SyntaxError, ZeroDivisionError) as error:
        return f"Could not calculate {expression!r}: {error}"


# Web search and page reading go through Tavily (https://docs.tavily.com), a
# search API built for agents. Without TAVILY_API_KEY the client runs keyless:
# search and extract still work, for free but rate limited. With a key (the free
# plan has 1,000 credits a month) the limits are higher. Pages are fetched by
# Tavily's servers, never by this one.
_tavily: AsyncTavilyClient | None = None


def _client() -> AsyncTavilyClient:
    global _tavily
    if _tavily is None:
        _tavily = AsyncTavilyClient(api_key=os.environ.get("TAVILY_API_KEY") or None)
    return _tavily


# Keep tool results small enough that a few pages fit in the model's context.
SNIPPET_CHARS = 500
PAGE_CHARS = 8000


@tool
async def web_search(
    query: str,
    topic: Literal["general", "news"] = "general",
    time_range: Literal["day", "week", "month", "year"] | None = None,
    max_results: int = 5,
) -> str:
    """Search the web. Use it for anything recent, changing or that you need to
    check. topic="news" for current events; time_range keeps results recent.
    Returns JSON: {"query", "results": [{"title", "url", "snippet", "published"}]}.
    Snippets are short: call read_webpage on the best results before answering."""
    try:
        response = await _client().search(
            query, topic=topic, time_range=time_range, max_results=max(1, min(max_results, 10))
        )
    except Exception as error:  # rate limit, network: tell the model instead of failing the run
        return json.dumps({"query": query, "error": str(error) or type(error).__name__})
    results = [
        {
            "title": r.get("title") or "",
            "url": r["url"],
            "snippet": (r.get("content") or "")[:SNIPPET_CHARS],
            **({"published": r["published_date"]} if r.get("published_date") else {}),
        }
        for r in response.get("results", [])
    ]
    return json.dumps({"query": query, "results": results}, ensure_ascii=False)


@tool
async def read_webpage(urls: list[str]) -> str:
    """Read up to 3 web pages (usually the best results from web_search) and
    return their main text as markdown, so you can answer from the source.
    Returns JSON: {"pages": [{"url", "title", "content"}], "failed": [{"url", "error"}]}."""
    try:
        response = await _client().extract(urls[:3], format="markdown")
    except Exception as error:
        return json.dumps({"error": str(error) or type(error).__name__})
    pages = []
    for r in response.get("results", []):
        content = r.get("raw_content") or ""
        if len(content) > PAGE_CHARS:
            content = content[:PAGE_CHARS] + "\n\n[Cut here: the page continues.]"
        pages.append({"url": r["url"], "title": r.get("title") or "", "content": content})
    failed = [{"url": f.get("url"), "error": f.get("error")} for f in response.get("failed_results", [])]
    return json.dumps({"pages": pages, "failed": failed}, ensure_ascii=False)


@tool
def delete_chat_history() -> str:
    """Delete this whole conversation, every message, for good. Use it only when
    the user asks to delete or clear the chat. The user must approve it first."""
    # The page deletes the thread (DELETE /agent) once this reply ends, so the
    # conversation is not erased while the agent is still writing to it.
    return "Approved: the whole chat history is deleted as soon as this reply ends."


TOOLS = [get_current_time, get_weather, calculate, web_search, read_webpage, delete_chat_history]
