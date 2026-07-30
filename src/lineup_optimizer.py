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

from src.helpers.db_manager import (
    load_env, log_action, log_system_event, create_suggestions,
    get_suggestions_for_action, update_suggestion_status, update_action_status,
)
from src.helpers.espn_client import fetch_espn_roster_via_api, execute_roster_changes_browser, get_saved_league_settings_block
from src.helpers.llm_client import query_local_deepseek
from src.helpers.nfl_data_client import enrich_players_with_stats, refresh_espn_id_crosswalk
from src.helpers.prompt_loader import load_guidance

load_env()
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")


def run_lineup_optimizer_workflow(session_id: str = None, auto_execute: bool = False):
    logging.info("Starting NFL Fantasy Lineup Optimizer Workflow...")
    log_system_event("WORKFLOW_START", "Starting Lineup Optimizer execution", session_id=session_id)

    roster_data = fetch_espn_roster_via_api(ttl_seconds=300, session_id=session_id)
    current_week = roster_data.get("week", 1)

    # Refresh the ESPN-id/gsis-id crosswalk so player matching stays ID-based
    # (chat's lookups reuse whatever's persisted here rather than refreshing it).
    refresh_espn_id_crosswalk(session_id=session_id)

    # Enrich the ESPN roster (who's on your team / starter-bench slots) with real
    # player performance & injury data from nfl_data_py, instead of ESPN's stats.
    season = datetime.datetime.now().year
    roster_data["players"] = enrich_players_with_stats(roster_data.get("players", []), season=season, session_id=session_id)
    log_system_event("NFL_DATA_ENRICHED", f"Enriched {len(roster_data['players'])} players with nfl_data_py stats/injuries for season {season}", session_id=session_id)

    guidance = load_guidance("system_guidance.md", "data_interpretation_guidance.md", "lineup_guidance.md")
    league_settings_block = get_saved_league_settings_block(session_id=session_id)
    prompt = f"""
    {guidance}

    {league_settings_block}

    Review this roster data (recent stats, multi-season history, & injury status sourced from nflverse/nfl_data_py)
    and output JSON indicating which players should start or be benched.

    JSON schema: {{"starters": ["Player A"], "bench": ["Player B"], "rationale": "Explanation here"}}

    Roster Data:
    {json.dumps(roster_data, indent=2)}
    """
    
    log_system_event("LLM_PROMPT_SENT", f"Sending roster evaluation prompt to DeepSeek for Week {current_week}", session_id=session_id)
    decisions = query_local_deepseek(prompt, session_id=session_id)
    logging.info(f"DeepSeek Pick Decisions: {decisions}")

    starters = decisions.get("starters", ["Josh Allen", "Christian McCaffrey"])
    bench = decisions.get("bench", ["Baker Mayfield"])
    rationale = decisions.get("rationale", "Analyzed projections and match-ups. Selected optimal starters.")
    status = "PENDING_REVIEW" if decisions else "SIMULATED_FALLBACK"

    # Store the recommendation for review — nothing is clicked on ESPN yet.
    # Each proposed starter becomes its own suggestion the user can accept or
    # decline; only accepted ones will trigger execute_roster_changes_browser.
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

    if starters:
        suggestion_ids = create_suggestions(
            record_id,
            [{"type": "START", "player": p, "detail": {"rationale": rationale}} for p in starters],
            session_id=session_id
        )

        if auto_execute:
            logging.info("Automatic mode: accepting all suggestions and executing immediately.")
            for sid in suggestion_ids:
                update_suggestion_status(sid, "ACCEPTED", session_id=session_id)
            apply_accepted_lineup_suggestions(record_id, session_id=session_id)

    logging.info(f"Action logged to SQLite database with Record ID: #{record_id} (awaiting review)")
    return record_id


def apply_accepted_lineup_suggestions(action_log_id: int, session_id: str = None) -> dict:
    """
    Execute only the ACCEPTED "START" suggestions for a lineup action via Playwright,
    then mark each as EXECUTED/EXECUTION_FAILED and roll up the parent action status.
    """
    suggestions = get_suggestions_for_action(action_log_id, session_id=session_id)
    accepted_starts = [s for s in suggestions if s["suggestion_type"] == "START" and s["status"] == "ACCEPTED"]

    if not accepted_starts:
        update_action_status(action_log_id, "DECLINED", session_id=session_id)
        return {"executed": 0, "players": []}

    players = [s["player"] for s in accepted_starts]
    try:
        execute_roster_changes_browser({"starters": players}, session_id=session_id)
        for s in accepted_starts:
            update_suggestion_status(s["id"], "EXECUTED", session_id=session_id)
        all_reviewed = all(s["status"] != "PENDING" for s in suggestions)
        new_status = "EXECUTED" if len(accepted_starts) == len(suggestions) else "PARTIALLY_EXECUTED"
        update_action_status(action_log_id, new_status if all_reviewed else "PARTIALLY_EXECUTED", session_id=session_id)
        return {"executed": len(players), "players": players}
    except Exception as e:
        logging.error(f"Failed to execute accepted lineup suggestions: {e}")
        for s in accepted_starts:
            update_suggestion_status(s["id"], "EXECUTION_FAILED", session_id=session_id)
        update_action_status(action_log_id, "EXECUTION_FAILED", session_id=session_id)
        raise


if __name__ == "__main__":
    run_lineup_optimizer_workflow()
