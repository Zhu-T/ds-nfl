"""
Free-form Q&A chat with DeepSeek, with the ability to look up real player
data via nfl_data_py mid-conversation.

Ollama's /api/generate (what llm_client.py uses everywhere else in this app)
has no native tool-calling, and DeepSeek-R1 distills aren't reliable with
OpenAI-style function calling anyway. So this implements a small ReAct-style
loop in plain Python instead: the model is told about one lookup tool and
asked to respond with a small JSON envelope — either a tool call or a final
answer — the same "ask for strict JSON, parse it" pattern already used by
every other prompt in this app (see llm_client.query_local_deepseek).
"""

import json
import logging
import datetime

from src.helpers.llm_client import query_local_deepseek
from src.helpers.nfl_data_client import enrich_players_with_stats
from src.helpers.espn_client import get_saved_league_settings_block
from src.helpers.prompt_loader import load_guidance
from src.helpers.db_manager import save_chat_message, get_chat_messages, log_system_event

MAX_TOOL_CALLS = 3

TOOL_INSTRUCTIONS = """You have one tool available for looking up real data: player stats.

To use it, respond with ONLY this JSON and nothing else (no markdown, no extra commentary):
{"tool": "lookup_player", "player_name": "Full Player Name"}
This returns that player's most recent game stats, their last several completed seasons
(season_stats_by_year), and current injury status, straight from nflverse.

You can call the tool more than once (e.g. to compare two players) before answering.

Once you have enough information, respond with ONLY this JSON:
{"tool": "answer", "text": "Your answer to the user, in plain conversational text."}

Always respond with exactly one of those two JSON shapes — never anything else."""


def _run_lookup_player(tool_call: dict, season: int, session_id: str = None) -> dict:
    player_name = tool_call.get("player_name", "")
    if not player_name:
        return {"error": "player_name is required"}
    result = enrich_players_with_stats([{"name": player_name}], season=season, session_id=session_id)
    return result[0] if result else {"error": f"No data found for {player_name}"}


def ask_deepseek(question: str, session_id: str = None) -> dict:
    """
    Answer a free-form question, running up to MAX_TOOL_CALLS player lookups
    along the way if DeepSeek asks for them. Saves both the question and the
    final answer (with its tool trace) to this session's chat history.
    Returns {"answer": str, "tool_trace": [{"call": ..., "result": ...}, ...]}.
    """
    save_chat_message("user", question, session_id=session_id)

    guidance = load_guidance("system_guidance.md")
    league_settings_block = get_saved_league_settings_block(session_id=session_id)
    season = datetime.datetime.now().year

    transcript = f"""{guidance}

{league_settings_block}

{TOOL_INSTRUCTIONS}

User question: {question}"""

    tool_trace = []
    for _ in range(MAX_TOOL_CALLS):
        response = query_local_deepseek(transcript, session_id=session_id)
        tool_name = response.get("tool")

        if tool_name == "lookup_player":
            log_system_event("CHAT_TOOL_CALL", f"Chat looked up player: {response.get('player_name')}", response, session_id=session_id)
            result = _run_lookup_player(response, season, session_id=session_id)
            tool_trace.append({"call": response, "result": result})
            transcript += (
                f"\n\nTool result:\n{json.dumps(result, indent=2, default=str)}\n\n"
                "Respond with your next tool call, or your final answer JSON if you have enough information now."
            )
            continue

        answer = response.get("text") if tool_name == "answer" else None
        if not answer:
            answer = "I couldn't come up with an answer — try rephrasing your question, or check that Ollama/DeepSeek is running."
        save_chat_message("assistant", answer, tool_trace=tool_trace, session_id=session_id)
        return {"answer": answer, "tool_trace": tool_trace}

    answer = "I looked up a few things but couldn't settle on an answer — try asking again with a more specific question."
    logging.warning(f"Chat hit the tool-call budget ({MAX_TOOL_CALLS}) without a final answer.")
    save_chat_message("assistant", answer, tool_trace=tool_trace, session_id=session_id)
    return {"answer": answer, "tool_trace": tool_trace}


def get_chat_history(session_id: str = None) -> list:
    return get_chat_messages(session_id=session_id)
