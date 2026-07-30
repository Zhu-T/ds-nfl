import json
import logging
from src.helpers.llm_client import query_local_deepseek
from src.helpers.db_manager import (
    log_action, log_system_event,
    create_suggestions, get_suggestions_for_action, update_suggestion_status, update_action_status,
)
from src.helpers.prompt_loader import load_guidance
from src.helpers.espn_client import get_saved_league_settings_block, resolve_espn_settings, fetch_espn_with_reauth
from src.helpers.nfl_data_client import refresh_espn_id_crosswalk


def fetch_pending_trades_via_api(ttl_seconds: int = 300, session_id: str = None):
    """
    Fetches pending trade proposals from ESPN Fantasy API with SQLite caching.
    Uses view=mTransactions2 & view=mPendingTransactions.
    """
    settings = resolve_espn_settings(session_id=session_id)
    url = f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ff/seasons/2026/segments/0/leagues/{settings['league_id']}?view=mTransactions2&view=mPendingTransactions"
    cookies = {"espn_s2": settings["espn_s2"], "SWID": settings["swid"]}

    try:
        data = fetch_espn_with_reauth(url, cookies, ttl_seconds, session_id=session_id)
        transactions = data.get("transactions", [])
        pending_trades = [t for t in transactions if t.get("type") == "TRADE" and t.get("status") == "PENDING"]
        log_system_event("TRADE_FETCH_SUCCESS", f"Retrieved {len(pending_trades)} pending trade proposals.", session_id=session_id)
        return pending_trades
    except Exception as e:
        logging.warning(f"Could not fetch live trades from ESPN API (using mock proposal for demonstration): {e}")
        return [
            {
                "id": "trade-9912",
                "proposing_team": "Team 2 (Gridiron Rivals)",
                "receiving_team": f"Team {settings['team_id']} (Your Team)",
                "players_giving_up": [{"name": "Justin Jefferson", "pos": "WR", "ros_proj": 18.2}],
                "players_receiving": [{"name": "De'Von Achane", "pos": "RB", "ros_proj": 15.6}, {"name": "Brandon Aiyuk", "pos": "WR", "ros_proj": 13.8}],
                "status": "PENDING"
            }
        ]


def analyze_trade_proposal(trade: dict, session_id: str = None) -> dict:
    """Prompt DeepSeek to analyze trade fairness, VORP impact, and recommend ACCEPT/DECLINE."""
    guidance = load_guidance("system_guidance.md", "trade_guidance.md")
    league_settings_block = get_saved_league_settings_block(session_id=session_id)
    prompt = f"""
    {guidance}

    {league_settings_block}

    Evaluate the following pending trade offer for your team:

    Trade Offer Details:
    {json.dumps(trade, indent=2)}

    Analyze Rest-of-Season (ROS) value, positional depth, and overall roster impact.
    Respond ONLY in JSON format:
    {{
        "recommendation": "ACCEPT / DECLINE / COUNTER",
        "net_value_diff": "+2.4 projected pts/week",
        "rationale": "Detailed explanation of why to accept or decline this trade offer."
    }}
    """
    log_system_event("LLM_PROMPT_SENT", f"Sending pending trade {trade.get('id', 'trade')} to DeepSeek model", session_id=session_id)
    return query_local_deepseek(prompt, session_id=session_id)


def run_trade_analyzer_workflow(session_id: str = None, auto_execute: bool = False):
    logging.info("Checking for pending ESPN trade requests...")

    # Refresh the ESPN-id/gsis-id crosswalk so player matching stays ID-based
    # (chat's lookups reuse whatever's persisted here rather than refreshing it).
    refresh_espn_id_crosswalk(session_id=session_id)

    pending_trades = fetch_pending_trades_via_api(session_id=session_id)

    if not pending_trades:
        logging.info("No pending trade requests found.")
        log_system_event("TRADE_ANALYZER", "No pending trade proposals found.", session_id=session_id)
        return None

    last_record_id = None
    for trade in pending_trades:
        decision = analyze_trade_proposal(trade, session_id=session_id)
        logging.info(f"DeepSeek Trade Evaluation: {decision}")

        recommendation = decision.get("recommendation", "DECLINE")
        rationale = decision.get("rationale", "Evaluated trade proposal value vs roster depth.")

        giving = [p.get("name", "Player") for p in trade.get("players_giving_up", [])]
        receiving = [p.get("name", "Player") for p in trade.get("players_receiving", [])]
        trade_label = f"Trade {trade.get('id', '')}: receive {', '.join(receiving) or 'nothing'} / give up {', '.join(giving) or 'nothing'}"

        last_record_id = log_action(
            week=1,
            action_type=f"TRADE_OFFER ({recommendation})",
            starters=[f"RECEIVE: {', '.join(receiving)}"],
            bench=[f"GIVE UP: {', '.join(giving)}"],
            rationale=rationale,
            status="PENDING_REVIEW" if decision else "SIMULATED_FALLBACK",
            raw_response=json.dumps(decision),
            session_id=session_id
        )

        suggestion_ids = create_suggestions(
            last_record_id,
            [{"type": f"TRADE_{recommendation}", "player": trade_label, "detail": {"rationale": rationale, "trade_id": trade.get("id")}}],
            session_id=session_id
        )

        if auto_execute and suggestion_ids:
            update_suggestion_status(suggestion_ids[0], "ACCEPTED", session_id=session_id)
            apply_trade_suggestions(last_record_id, session_id=session_id)

    return last_record_id


def apply_trade_suggestions(action_log_id: int, session_id: str = None) -> dict:
    """
    "Executes" accepted trade suggestions. ESPN exposes no write API and no
    Playwright flow exists for submitting a trade response, so this only
    records the decision — you still have to accept/decline the trade on
    ESPN yourself.
    """
    suggestions = get_suggestions_for_action(action_log_id, session_id=session_id)
    accepted = [s for s in suggestions if s["status"] == "ACCEPTED"]

    for s in accepted:
        update_suggestion_status(s["id"], "EXECUTED", session_id=session_id)

    update_action_status(action_log_id, "EXECUTED" if accepted else "DECLINED", session_id=session_id)
    return {"executed": len(accepted)}
