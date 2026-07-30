"""
ESPN Live Draft Helper
Parses ESPN Live Draft Room UI via Playwright and executes DeepSeek recommended picks.
"""

import os
import json
import logging
import datetime
from playwright.sync_api import sync_playwright
from src.helpers.llm_client import query_local_deepseek
from src.helpers.db_manager import (
    log_action, create_suggestions, get_suggestions_for_action,
    update_suggestion_status, update_action_status, log_system_event,
)
from src.helpers.nfl_data_client import enrich_players_with_stats, refresh_espn_id_crosswalk
from src.helpers.espn_client import (
    ensure_espn_login, fetch_espn_league_settings, format_league_settings_block, format_draft_order_block,
    resolve_espn_settings,
)
from src.helpers.prompt_loader import load_guidance


def analyze_draft_pick(available_players: list, current_roster: list, current_pick: int, league_settings_block: str = "", session_id: str = None) -> dict:
    """Prompt DeepSeek to recommend the best available player based on VORP and team needs."""
    guidance = load_guidance("system_guidance.md", "data_interpretation_guidance.md", "draft_guidance.md")
    prompt = f"""
    {guidance}

    {league_settings_block}

    It is your turn to pick in a live draft (Pick #{current_pick}).

    Current Team Roster:
    {json.dumps(current_roster, indent=2)}

    Top Available Players:
    {json.dumps(available_players[:15], indent=2)}

    Analyze positional scarcity, team needs, and projected value.
    Respond ONLY in JSON format:
    {{
        "recommended_player": "Player Name",
        "position": "QB/RB/WR/TE",
        "rationale": "Detailed explanation for why this player is the best pick."
    }}
    """
    return query_local_deepseek(prompt, session_id=session_id)


def run_live_draft_assistant(draft_url: str = None, session_id: str = None, auto_execute: bool = False):
    """
    Launches Playwright browser to attach to ESPN Live Draft Room, reads available
    players, and asks DeepSeek for a pick recommendation. Nothing is drafted yet —
    this logs a single DRAFT_PICK suggestion for review; accepting it (via
    draft_player_via_browser / apply_accepted_draft_suggestion) is what actually
    clicks Draft on ESPN.
    """
    if not draft_url:
        draft_url = f"https://fantasy.espn.com/football/draft?leagueId={resolve_espn_settings(session_id=session_id)['league_id']}"

    logging.info(f"Connecting to ESPN Live Draft Room: {draft_url}")
    
    with sync_playwright() as p:
        temp_dir = os.environ.get("TEMP", "C:/tmp")
        profile_dir = os.path.join(temp_dir, "espn_openclaw_profile")
        
        browser = p.chromium.launch_persistent_context(
            user_data_dir=profile_dir,
            headless=False,
            args=["--disable-blink-features=AutomationControlled"]
        )
        
        page = browser.new_page()
        page.goto(draft_url)
        page.wait_for_timeout(5000)

        ensure_espn_login(page, session_id=session_id)

        # Refresh the ESPN-id/gsis-id crosswalk so player matching stays ID-based
        # (chat's lookups reuse whatever's persisted here rather than refreshing it).
        refresh_espn_id_crosswalk(session_id=session_id)

        # League/roster settings are fixed for the season once the draft starts,
        # so this is the only workflow that fetches them fresh from ESPN — lineup
        # and trade just read back whatever gets saved here.
        league_settings = fetch_espn_league_settings(session_id=session_id)
        draft_context_block = "\n\n".join(filter(None, [
            format_league_settings_block(league_settings),
            format_draft_order_block(league_settings.get("draft_order", []), league_settings.get("draft_type", "SNAKE")),
        ]))

        logging.info("Scanning ESPN Draft Room for available players...")

        # Scrape top available players from ESPN Draft Room DOM table
        available_players = []
        try:
            player_elements = page.locator(".draftTable__row")
            count = player_elements.count()
            for i in range(min(count, 15)):
                text = player_elements.nth(i).inner_text().replace("\n", " ")
                available_players.append({"rank": i + 1, "details": text})
        except Exception as e:
            logging.warning(f"Could not scrape live draft table (using mock demo data): {e}")
            available_players = [
                {"name": "Ja'Marr Chase", "pos": "WR", "adp": 4.2},
                {"name": "Breece Hall", "pos": "RB", "adp": 5.1},
                {"name": "Bijan Robinson", "pos": "RB", "adp": 6.0},
                {"name": "Amon-Ra St. Brown", "pos": "WR", "adp": 7.5}
            ]

        # Enrich available players with real prior-season stats & injury status
        # from nfl_data_py (players without a resolvable "name" pass through unchanged).
        season = datetime.datetime.now().year
        available_players = enrich_players_with_stats(available_players, season=season, session_id=session_id)

        current_roster = []
        decision = analyze_draft_pick(available_players, current_roster, current_pick=12, league_settings_block=draft_context_block, session_id=session_id)
        logging.info(f"DeepSeek Draft Pick Recommendation: {decision}")
        
        rec_player = decision.get("recommended_player", "Ja'Marr Chase")
        rationale = decision.get("rationale", "Best available value player.")
        status = "PENDING_REVIEW" if decision else "SIMULATED_FALLBACK"

        # Log the recommendation for review — nothing is clicked on ESPN yet.
        record_id = log_action(
            week=0,  # Week 0 represents Draft
            action_type="LIVE_DRAFT_PICK",
            starters=[rec_player],
            bench=[],
            rationale=rationale,
            status=status,
            prompt_sent=f"Draft Pick #{current_pick} Analysis Prompt for players: {[p.get('name') for p in available_players[:5]]}",
            raw_response=json.dumps(decision),
            session_id=session_id
        )

        suggestion_ids = []
        if rec_player:
            suggestion_ids = create_suggestions(
                record_id,
                [{"type": "DRAFT_PICK", "player": rec_player, "detail": {"rationale": rationale, "draft_url": draft_url}}],
                session_id=session_id
            )

        page.wait_for_timeout(3000)
        browser.close()

        if auto_execute and suggestion_ids:
            logging.info("Automatic mode: accepting the recommended pick and drafting it immediately.")
            update_suggestion_status(suggestion_ids[0], "ACCEPTED", session_id=session_id)
            apply_accepted_draft_suggestion(record_id, session_id=session_id)

        logging.info(f"Draft recommendation logged as Record ID: #{record_id} (awaiting review)")
        return record_id


def draft_player_via_browser(player_name: str, draft_url: str = None, session_id: str = None) -> bool:
    """
    Opens the ESPN Live Draft Room and clicks Draft/Queue for the given player.
    Called only after a DRAFT_PICK suggestion has been accepted by the user.
    Returns True if the button was found and clicked.
    """
    if not draft_url:
        draft_url = f"https://fantasy.espn.com/football/draft?leagueId={resolve_espn_settings(session_id=session_id)['league_id']}"

    logging.info(f"Attempting to draft {player_name} on ESPN UI...")
    with sync_playwright() as p:
        temp_dir = os.environ.get("TEMP", "C:/tmp")
        profile_dir = os.path.join(temp_dir, "espn_openclaw_profile")

        browser = p.chromium.launch_persistent_context(
            user_data_dir=profile_dir,
            headless=False,
            args=["--disable-blink-features=AutomationControlled"]
        )
        page = browser.new_page()
        page.goto(draft_url)
        page.wait_for_timeout(5000)

        ensure_espn_login(page, session_id=session_id)

        clicked = False
        try:
            player_row = page.locator(f"tr:has-text('{player_name}')")
            if player_row.count() > 0:
                draft_btn = player_row.locator("button:has-text('Draft'), button:has-text('Queue')")
                if draft_btn.count() > 0:
                    draft_btn.first.click()
                    clicked = True
                    logging.info(f"Draft button clicked for {player_name}!")
                    log_system_event("BROWSER_ACTION", f"Clicked Draft/Queue for {player_name}", session_id=session_id)
        except Exception as e:
            logging.error(f"Could not click draft button for {player_name}: {e}")
            log_system_event("BROWSER_ACTION_ERROR", f"Failed to draft {player_name}: {e}", session_id=session_id)

        page.wait_for_timeout(2000)
        browser.close()
        return clicked


def apply_accepted_draft_suggestion(action_log_id: int, session_id: str = None) -> dict:
    """Execute the ACCEPTED DRAFT_PICK suggestion for a draft action, if any."""
    suggestions = get_suggestions_for_action(action_log_id, session_id=session_id)
    accepted_picks = [s for s in suggestions if s["suggestion_type"] == "DRAFT_PICK" and s["status"] == "ACCEPTED"]

    if not accepted_picks:
        update_action_status(action_log_id, "DECLINED", session_id=session_id)
        return {"executed": 0, "player": None}

    pick = accepted_picks[0]
    draft_url = (pick.get("detail") or {}).get("draft_url")
    try:
        clicked = draft_player_via_browser(pick["player"], draft_url=draft_url, session_id=session_id)
        update_suggestion_status(pick["id"], "EXECUTED" if clicked else "EXECUTION_FAILED", session_id=session_id)
        update_action_status(action_log_id, "EXECUTED" if clicked else "EXECUTION_FAILED", session_id=session_id)
        return {"executed": 1 if clicked else 0, "player": pick["player"]}
    except Exception as e:
        logging.error(f"Failed to execute accepted draft suggestion: {e}")
        update_suggestion_status(pick["id"], "EXECUTION_FAILED", session_id=session_id)
        update_action_status(action_log_id, "EXECUTION_FAILED", session_id=session_id)
        raise
