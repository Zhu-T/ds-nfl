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
from src.helpers.db_manager import log_action
from src.helpers.nfl_data_client import enrich_players_with_stats

ESPN_LEAGUE_ID = os.getenv("ESPN_LEAGUE_ID", "12345678")
ESPN_TEAM_ID = os.getenv("ESPN_TEAM_ID", "1")


def analyze_draft_pick(available_players: list, current_roster: list, current_pick: int) -> dict:
    """Prompt DeepSeek to recommend the best available player based on VORP and team needs."""
    prompt = f"""
    You are an expert NFL Fantasy Football Draft Strategist.
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
    return query_local_deepseek(prompt)


def run_live_draft_assistant(draft_url: str = None, auto_click_draft: bool = False, session_id: str = None):
    """
    Launches Playwright browser to attach to ESPN Live Draft Room.
    Reads available players and executes/queues draft picks via DeepSeek.
    """
    if not draft_url:
        draft_url = f"https://fantasy.espn.com/football/draft?leagueId={ESPN_LEAGUE_ID}"

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
        available_players = enrich_players_with_stats(available_players, season=season)

        current_roster = []
        decision = analyze_draft_pick(available_players, current_roster, current_pick=12)
        logging.info(f"DeepSeek Draft Pick Recommendation: {decision}")
        
        rec_player = decision.get("recommended_player", "Ja'Marr Chase")
        rationale = decision.get("rationale", "Best available value player.")
        
        if auto_click_draft and rec_player:
            logging.info(f"Attempting to draft {rec_player} on ESPN UI...")
            try:
                player_row = page.locator(f"tr:has-text('{rec_player}')")
                if player_row.count() > 0:
                    draft_btn = player_row.locator("button:has-text('Draft'), button:has-text('Queue')")
                    if draft_btn.count() > 0:
                        draft_btn.first.click()
                        logging.info(f"Draft button clicked for {rec_player}!")
            except Exception as e:
                logging.error(f"Could not click draft button: {e}")
        
        # Log draft action to SQLite with prompt sent & response received
        log_action(
            week=0,  # Week 0 represents Draft
            action_type="LIVE_DRAFT_PICK",
            starters=[rec_player],
            bench=[],
            rationale=rationale,
            status="SUCCESS" if decision else "SIMULATED_FALLBACK",
            prompt_sent=f"Draft Pick #{current_pick} Analysis Prompt for players: {[p.get('name') for p in available_players[:5]]}",
            raw_response=json.dumps(decision),
            session_id=session_id
        )

        page.wait_for_timeout(3000)
        browser.close()
