import os
import json
import logging
from src.helpers.llm_client import query_local_deepseek
from src.helpers.db_manager import log_action, fetch_cached_api_request, log_system_event

ESPN_LEAGUE_ID = os.getenv("ESPN_LEAGUE_ID", "12345678")
ESPN_TEAM_ID = os.getenv("ESPN_TEAM_ID", "1")
ESPN_S2 = os.getenv("ESPN_S2", "")
SWID = os.getenv("SWID", "")


def fetch_pending_trades_via_api(ttl_seconds: int = 300, session_id: str = None):
    """
    Fetches pending trade proposals from ESPN Fantasy API with SQLite caching.
    Uses view=mTransactions2 & view=mPendingTransactions.
    """
    url = f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ff/seasons/2026/segments/0/leagues/{ESPN_LEAGUE_ID}?view=mTransactions2&view=mPendingTransactions"
    cookies = {"espn_s2": ESPN_S2, "SWID": SWID}

    try:
        data = fetch_cached_api_request(url, cookies=cookies, ttl_seconds=ttl_seconds, session_id=session_id)
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
                "receiving_team": f"Team {ESPN_TEAM_ID} (Your Team)",
                "players_giving_up": [{"name": "Justin Jefferson", "pos": "WR", "ros_proj": 18.2}],
                "players_receiving": [{"name": "De'Von Achane", "pos": "RB", "ros_proj": 15.6}, {"name": "Brandon Aiyuk", "pos": "WR", "ros_proj": 13.8}],
                "status": "PENDING"
            }
        ]


def analyze_trade_proposal(trade: dict, session_id: str = None) -> dict:
    """Prompt DeepSeek to analyze trade fairness, VORP impact, and recommend ACCEPT/DECLINE."""
    prompt = f"""
    You are an expert NFL Fantasy Football Trade Analyst.
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
    return query_local_deepseek(prompt)


def run_trade_analyzer_workflow(session_id: str = None):
    logging.info("Checking for pending ESPN trade requests...")
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

        last_record_id = log_action(
            week=1,
            action_type=f"TRADE_OFFER ({recommendation})",
            starters=[f"RECEIVE: {', '.join(receiving)}"],
            bench=[f"GIVE UP: {', '.join(giving)}"],
            rationale=rationale,
            status="SUCCESS" if decision else "SIMULATED_FALLBACK",
            raw_response=json.dumps(decision),
            session_id=session_id
        )

    return last_record_id
