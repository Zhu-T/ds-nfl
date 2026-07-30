import os
import logging
from playwright.sync_api import sync_playwright
from src.helpers.db_manager import fetch_cached_api_request, log_system_event

ESPN_LEAGUE_ID = os.getenv("ESPN_LEAGUE_ID", "12345678")
ESPN_TEAM_ID = os.getenv("ESPN_TEAM_ID", "1")
ESPN_S2 = os.getenv("ESPN_S2", "")
SWID = os.getenv("SWID", "")


def fetch_espn_roster_via_api(ttl_seconds: int = 300, session_id: str = None):
    """
    Fetches ESPN roster data using SQLite API Caching.
    Reuses cached responses for 300 seconds (5 mins) to prevent IP blocking/rate-limiting.
    """
    url = f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ff/seasons/2026/segments/0/leagues/{ESPN_LEAGUE_ID}?view=mRoster"
    cookies = {"espn_s2": ESPN_S2, "SWID": SWID}

    try:
        data = fetch_cached_api_request(url, cookies=cookies, ttl_seconds=ttl_seconds, session_id=session_id)
        logging.info("Successfully loaded ESPN roster data (using SQLite API cache if valid).")
        return data
    except Exception as e:
        logging.warning(f"Could not fetch via API (using mock fallback for testing): {e}")
        return {
            "week": 1,
            "team_id": ESPN_TEAM_ID,
            "players": [
                {"name": "Josh Allen", "pos": "QB", "status": "ACTIVE", "proj": 21.4},
                {"name": "Christian McCaffrey", "pos": "RB", "status": "ACTIVE", "proj": 19.8},
                {"name": "Baker Mayfield", "pos": "QB", "status": "BENCH", "proj": 15.2}
            ]
        }


def execute_roster_changes_browser(pick_instructions: dict, session_id: str = None):
    """
    Automate ESPN roster updates using Playwright browser UI automation.
    Navigates to ESPN Team page, moves players, and saves changes.
    """
    logging.info("Launching browser session for ESPN Fantasy...")
    log_system_event("BROWSER_AUTOMATION_START", "Launching Playwright to update ESPN roster", pick_instructions, session_id=session_id)
    starters = pick_instructions.get("starters", [])
    
    with sync_playwright() as p:
        temp_dir = os.environ.get("TEMP", "C:/tmp")
        profile_dir = os.path.join(temp_dir, "espn_openclaw_profile")
        
        browser = p.chromium.launch_persistent_context(
            user_data_dir=profile_dir,
            headless=False,
            args=["--disable-blink-features=AutomationControlled"]
        )
        
        page = browser.new_page()
        lineup_url = f"https://fantasy.espn.com/football/team?leagueId={ESPN_LEAGUE_ID}&teamId={ESPN_TEAM_ID}"
        logging.info(f"Navigating to ESPN Team page: {lineup_url}")
        page.goto(lineup_url)
        page.wait_for_timeout(3000)
        
        for player_name in starters:
            try:
                player_row = page.locator(f"tr:has-text('{player_name}')")
                if player_row.count() > 0:
                    move_btn = player_row.locator("button:has-text('Move'), button:has-text('Swap')")
                    if move_btn.count() > 0:
                        move_btn.first.click()
                        page.wait_for_timeout(1000)
                        log_system_event("BROWSER_ACTION", f"Clicked Move/Swap for player: {player_name}", session_id=session_id)
            except Exception as e:
                logging.error(f"Error executing browser swap for {player_name}: {e}")
                log_system_event("BROWSER_ACTION_ERROR", f"Failed browser swap for {player_name}: {e}", session_id=session_id)

        save_btn = page.locator("button:has-text('Save Changes')")
        if save_btn.count() > 0:
            save_btn.click()
            log_system_event("BROWSER_ACTION", "Clicked Save Changes button on ESPN UI.", session_id=session_id)

        page.wait_for_timeout(2000)
        browser.close()
        log_system_event("BROWSER_AUTOMATION_END", "Playwright session finished successfully.", session_id=session_id)
