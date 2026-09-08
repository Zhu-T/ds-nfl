"""
Lineup Optimizer Entry Point
Evaluates ESPN roster & match-ups using local DeepSeek model.
"""

import sys
import os
import json
import logging
import datetime
import re

# Ensure root directory is in python path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from src.helpers.db_manager import (
    load_env, log_action, log_system_event, create_suggestions,
    get_suggestions_for_action, update_suggestion_status, update_action_status,
    get_league_settings,
)
from src.helpers.espn_client import (
    scrape_lineup_from_team_page,
    execute_roster_changes_browser,
    format_league_settings_block,
)
from src.helpers.llm_client import query_local_deepseek
from src.helpers.nfl_data_client import enrich_players_with_stats, refresh_espn_id_crosswalk
from src.helpers.prompt_loader import load_guidance

load_env()
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")


def _name_key(name: str) -> str:
    text = re.sub(r"[^a-z0-9 ]", "", (name or "").lower())
    text = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", "", text)
    return re.sub(r"\s+", " ", text).strip()


def _on_roster(name: str, roster_names: list) -> str:
    key = _name_key(name)
    if not key:
        return ""
    for other in roster_names:
        other_key = _name_key(other)
        if key == other_key or key in other_key or other_key in key:
            return other
    return ""


def _stat_num(value):
    if value is None or value == "":
        return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if num != num:
        return None
    if num == int(num):
        return int(num)
    return round(num, 1)


def _format_lineup_roster(players) -> str:
    """Compact roster lines. The full enriched JSON makes DeepSeek-R1 think past the read timeout."""
    lines = []
    for player in players or []:
        name = (player.get("name") or "").strip()
        if not name:
            continue
        recent = player.get("recent_stats") or {}
        seasons = []
        for row in player.get("season_stats_by_year") or []:
            year = row.get("season")
            ppr = _stat_num(row.get("fantasy_points_ppr"))
            games = _stat_num(row.get("games"))
            if year is None and ppr is None:
                continue
            bit = str(year) if year is not None else "?"
            if ppr is not None:
                bit += f" {ppr}ppr"
            if games is not None:
                bit += f"/{games}g"
            seasons.append(bit)
        bits = [
            name,
            player.get("pos") or "",
            player.get("lineup_slot") or "",
            player.get("status") or "",
        ]
        injury = player.get("injury_status")
        if injury and injury not in ("ACTIVE", "UNKNOWN"):
            bits.append(f"injury={injury}")
        recent_ppr = _stat_num(recent.get("fantasy_points_ppr"))
        if recent_ppr is not None:
            bits.append(f"last_game_ppr={recent_ppr}")
        if seasons:
            bits.append("seasons=" + ", ".join(seasons))
        lines.append(" | ".join(str(bit) for bit in bits if bit))
    return "\n".join(lines) or "(none)"


def _keep_roster_names(names, roster_names: list) -> list:
    kept = []
    seen = set()
    for name in names or []:
        match = _on_roster(name, roster_names)
        if not match:
            continue
        key = _name_key(match)
        if key in seen:
            continue
        seen.add(key)
        kept.append(match)
    return kept


def run_lineup_optimizer_workflow(session_id: str = None, auto_execute: bool = False, lineup_url: str = None):
    logging.info("Starting NFL Fantasy Lineup Optimizer Workflow...")
    log_system_event("WORKFLOW_START", "Starting Lineup Optimizer execution", session_id=session_id)

    roster_data = scrape_lineup_from_team_page(lineup_url, session_id=session_id)
    current_week = roster_data.get("week", 1)
    eligible = [
        p.get("name")
        for p in roster_data.get("players") or []
        if p.get("name") and (p.get("status") or "") != "IR"
    ]

    # Refresh the ESPN-id/gsis-id crosswalk so player matching stays ID-based
    # (chat's lookups reuse whatever's persisted here rather than refreshing it).
    refresh_espn_id_crosswalk(session_id=session_id)

    # Enrich the scraped roster (starters / bench from the team page) with
    # player performance & injury data from nflreadpy, instead of ESPN's stats.
    season = datetime.datetime.now().year
    roster_data["players"] = enrich_players_with_stats(roster_data.get("players", []), season=season, session_id=session_id)
    log_system_event("NFL_DATA_ENRICHED", f"Enriched {len(roster_data['players'])} players with nflreadpy stats/injuries for season {season}", session_id=session_id)

    guidance = load_guidance("system_guidance.md", "lineup_guidance.md")
    saved = get_league_settings(session_id=session_id)
    league_settings_block = format_league_settings_block(saved) if saved else ""
    allowed_lines = "\n".join(f"- {name}" for name in eligible) or "(none)"
    roster_lines = _format_lineup_roster(roster_data.get("players"))
    prompt = f"""
{guidance}

DECISION: set this week's starting lineup vs bench. Reply with the JSON object only. Keep rationale to one sentence.

ALLOWED PLAYERS — these are the only names you may use. Copy them exactly. Do not add, invent, or substitute anyone else:
{allowed_lines}

ACTIVE means currently starting. BENCH means currently benched. IR players are listed below but must not be placed in starters.
Only bench players who should come into the lineup are start changes. Do not treat a player who is already ACTIVE as a new start.

REPLY FORMAT — JSON object only. Every name in starters and bench must appear in ALLOWED PLAYERS:
{{"starters": ["<one allowed name>"], "bench": ["<one allowed name>"], "rationale": "short why"}}

---

{league_settings_block}

ROSTER (one player per line):
{roster_lines}
"""
    
    log_system_event("LLM_PROMPT_SENT", f"Sending roster evaluation prompt to DeepSeek for Week {current_week}", session_id=session_id)
    # 10 minutes overall. The HTTP read timeout stays 3 minutes of silence between
    # streamed tokens. think=False skips the R1 trace that never reached the socket.
    decisions = query_local_deepseek(prompt, session_id=session_id, timeout=600, think=False)
    logging.info(f"DeepSeek Pick Decisions: {decisions}")

    starters = _keep_roster_names(decisions.get("starters") or [], eligible)
    bench = _keep_roster_names(decisions.get("bench") or [], eligible)
    already_starting = {
        _name_key(p.get("name"))
        for p in roster_data.get("players") or []
        if p.get("name") and (p.get("status") or "") == "ACTIVE"
    }
    start_moves = [name for name in starters if _name_key(name) not in already_starting]
    used = {_name_key(n) for n in starters + bench}
    for name in eligible:
        if _name_key(name) not in used:
            bench.append(name)
            used.add(_name_key(name))
    dropped = [
        n for n in (decisions.get("starters") or []) + (decisions.get("bench") or [])
        if n and not _on_roster(n, eligible)
    ]
    rationale = (decisions.get("rationale") or "").strip() or "Compared the scraped starters and bench."
    if dropped:
        rationale = f"{rationale} Ignored names not on the team page: {', '.join(dropped)}."
    if starters and not start_moves:
        rationale = f"{rationale} No changes — recommended starters are already starting."
    if not starters:
        if not decisions:
            raise RuntimeError("DeepSeek did not return a lineup. Check the console for a timeout or empty reply.")
        raise RuntimeError("DeepSeek did not name any starter who is on the scraped team page.")
    status = "PENDING_REVIEW" if decisions else "SIMULATED_FALLBACK"
    if not start_moves:
        status = "NO_CHANGES"

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

    if start_moves:
        suggestion_ids = create_suggestions(
            record_id,
            [{"type": "START", "player": p, "detail": {"rationale": rationale}} for p in start_moves],
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
        # Re-read so rollup reflects EXECUTED vs still-PENDING siblings.
        suggestions = get_suggestions_for_action(action_log_id, session_id=session_id)
        pending_left = any(s["status"] == "PENDING" for s in suggestions)
        accepted_left = any(s["status"] == "ACCEPTED" for s in suggestions)
        if pending_left or accepted_left:
            new_status = "PARTIALLY_EXECUTED"
        else:
            new_status = "EXECUTED"
        update_action_status(action_log_id, new_status, session_id=session_id)
        return {"executed": len(players), "players": players}
    except Exception as e:
        logging.error(f"Failed to execute accepted lineup suggestions: {e}")
        for s in accepted_starts:
            update_suggestion_status(s["id"], "EXECUTION_FAILED", session_id=session_id)
        update_action_status(action_log_id, "EXECUTION_FAILED", session_id=session_id)
        raise


if __name__ == "__main__":
    run_lineup_optimizer_workflow()
