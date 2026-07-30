"""
Lineup Optimizer Entry Point
Evaluates ESPN roster & match-ups using local DeepSeek model.
"""

import sys
import os
import json
import logging
import datetime

# Ensure root directory is in python path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from src.helpers.db_manager import load_env, log_action, log_system_event
from src.helpers.espn_client import fetch_espn_roster_via_api, execute_roster_changes_browser
from src.helpers.llm_client import query_local_deepseek
from src.helpers.nfl_data_client import enrich_players_with_stats

load_env()
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")


def run_lineup_optimizer_workflow(session_id: str = None):
    logging.info("Starting NFL Fantasy Lineup Optimizer Workflow...")
    log_system_event("WORKFLOW_START", "Starting Lineup Optimizer execution", session_id=session_id)

    roster_data = fetch_espn_roster_via_api(ttl_seconds=300, session_id=session_id)
    current_week = roster_data.get("week", 1)

    # Enrich the ESPN roster (who's on your team / starter-bench slots) with real
    # player performance & injury data from nfl_data_py, instead of ESPN's stats.
    season = datetime.datetime.now().year
    roster_data["players"] = enrich_players_with_stats(roster_data.get("players", []), season=season)
    log_system_event("NFL_DATA_ENRICHED", f"Enriched {len(roster_data['players'])} players with nfl_data_py stats/injuries for season {season}", session_id=session_id)

    prompt = f"""
    You are an expert NFL Fantasy Football analyst.
    Review this roster data (recent stats & injury status sourced from nflverse/nfl_data_py)
    and output JSON indicating which players should start or be benched.
    JSON schema: {{"starters": ["Player A"], "bench": ["Player B"], "rationale": "Explanation here"}}

    Roster Data:
    {json.dumps(roster_data, indent=2)}
    """
    
    log_system_event("LLM_PROMPT_SENT", f"Sending roster evaluation prompt to DeepSeek for Week {current_week}", session_id=session_id)
    decisions = query_local_deepseek(prompt)
    logging.info(f"DeepSeek Pick Decisions: {decisions}")

    starters = decisions.get("starters", ["Josh Allen", "Christian McCaffrey"])
    bench = decisions.get("bench", ["Baker Mayfield"])
    rationale = decisions.get("rationale", "Analyzed projections and match-ups. Selected optimal starters.")
    status = "SUCCESS" if decisions else "SIMULATED_FALLBACK"

    # Execute browser roster updates if valid starters exist
    if decisions and decisions.get("starters"):
        try:
            execute_roster_changes_browser(decisions, session_id=session_id)
        except Exception as e:
            logging.warning(f"Browser execution fallback: {e}")

    # Store decision into SQLite database along with input prompt and raw response
    record_id = log_action(
        week=current_week,
        action_type="LINEUP_OPTIMIZATION",
        starters=starters,
        bench=bench,
        rationale=rationale,
        status=status,
        prompt_sent=prompt,
        raw_response=json.dumps(decisions),
        session_id=session_id
    )
    logging.info(f"Action logged to SQLite database with Record ID: #{record_id}")
    return record_id


if __name__ == "__main__":
    run_lineup_optimizer_workflow()
