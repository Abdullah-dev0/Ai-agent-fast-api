"""The agent's tools: plain Python functions the model can decide to call.

The @tool decorator turns each function into something the model can see:
its name, its arguments (from the type hints) and what it does (from the
docstring). Write the docstring for the model, it is how it picks a tool.
"""

import ast
import operator
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from langchain.tools import tool


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


@tool
def delete_chat_history() -> str:
    """Delete this whole conversation, every message, for good. Use it only when
    the user asks to delete or clear the chat. The user must approve it first."""
    # The page deletes the thread (DELETE /agent) once this reply ends, so the
    # conversation is not erased while the agent is still writing to it.
    return "Approved: the whole chat history is deleted as soon as this reply ends."


TOOLS = [get_current_time, get_weather, calculate, delete_chat_history]
