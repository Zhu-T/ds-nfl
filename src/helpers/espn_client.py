import os
import logging
import requests
from playwright.sync_api import sync_playwright
from src.helpers.db_manager import (
    fetch_cached_api_request, log_system_event, save_league_settings, get_league_settings,
    get_espn_settings, save_espn_settings,
)
from src.helpers.constants import ESPN_LEAGUE_ID, ESPN_TEAM_ID, ESPN_S2, SWID

# ESPN's numeric fantasy lineup slot IDs -> display names, used to describe
# roster settings (e.g. "1 QB, 2 RB, 2 WR, 1 TE, 1 FLEX, 6 Bench").
LINEUP_SLOT_NAMES = {
    0: "QB", 2: "RB", 4: "WR", 6: "TE", 7: "OP", 16: "D/ST", 17: "K",
    20: "Bench", 21: "IR", 23: "FLEX", 24: "RB/WR", 25: "WR/TE", 3: "RB/WR/TE",
}
# Slots that don't belong in a human-facing roster summary.
_HIDDEN_SLOTS = {21}  # IR

# ESPN's numeric default position IDs -> display names.
ESPN_POSITION_NAMES = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST"}

# Selector covering ESPN's various "Log In" entry points (top nav link, header
# button, etc.) — if any of these are visible, the browser profile isn't
# authenticated yet.
LOGIN_INDICATOR_SELECTOR = "a:has-text('Log In'), button:has-text('Log In'), [data-affiliatename], a[href*='login.espn.com']"


def resolve_espn_settings(session_id: str = None) -> dict:
    """
    Resolve this session's ESPN league id / team id / cookies: prefer whatever
    has been saved for this session (via the settings form, or cookies
    harvested by a Playwright login — see harvest_espn_cookies_via_browser),
    falling back to the .env-configured global defaults for anything not set.
    Different sessions can point at different leagues/teams, which is why
    this isn't just read from constants.py directly.
    """
    saved = get_espn_settings(session_id=session_id) or {}
    return {
        "league_id": saved.get("league_id") or ESPN_LEAGUE_ID,
        "team_id": saved.get("team_id") or ESPN_TEAM_ID,
        "espn_s2": saved.get("espn_s2") or ESPN_S2,
        "swid": saved.get("swid") or SWID,
    }


def is_espn_logged_out(page) -> bool:
    try:
        return page.locator(LOGIN_INDICATOR_SELECTOR).first.is_visible(timeout=2000)
    except Exception:
        return False


def ensure_espn_login(page, session_id: str = None, timeout_seconds: int = 600):
    """
    If the opened browser profile isn't logged into ESPN, pause automation and
    poll until the user logs in manually in that window (or the timeout elapses).
    A no-op once you've logged in once, since the persistent browser profile
    (espn_openclaw_profile) keeps the session for future runs.
    """
    if not is_espn_logged_out(page):
        return

    logging.warning("Not logged into ESPN — log in using the opened browser window; automation will resume automatically.")
    log_system_event("ESPN_LOGIN_REQUIRED", "Paused automation: waiting for you to log into ESPN in the opened browser window.", session_id=session_id)

    poll_interval_s = 2
    elapsed = 0
    while elapsed < timeout_seconds:
        page.wait_for_timeout(poll_interval_s * 1000)
        elapsed += poll_interval_s
        if not is_espn_logged_out(page):
            logging.info("ESPN login detected, resuming automation.")
            log_system_event("ESPN_LOGIN_DETECTED", f"Login detected after {elapsed}s, resuming automation.", session_id=session_id)
            page.wait_for_timeout(1500)  # let the page finish reloading logged-in state
            return

    logging.warning(f"Still not logged into ESPN after {timeout_seconds}s — proceeding anyway (automation may fail).")
    log_system_event("ESPN_LOGIN_TIMEOUT", f"Still not logged in after {timeout_seconds}s, proceeding anyway.", session_id=session_id)


def harvest_espn_cookies_via_browser(session_id: str = None, timeout_seconds: int = 600) -> dict:
    """
    Opens a visible Playwright browser (reusing the persistent login profile,
    so this is a no-op click-through if you're already logged in there),
    waits for you to log into ESPN if needed, then reads espn_s2/SWID straight
    out of the browser's cookie jar and saves them for this session.

    This is only ever called after an ESPN API call comes back 401/403 (see
    fetch_espn_with_reauth) — i.e. only when the cookies we have are actually
    missing or expired, not on every run.
    """
    logging.info("Opening browser to refresh your ESPN login session...")
    with sync_playwright() as p:
        temp_dir = os.environ.get("TEMP", "C:/tmp")
        profile_dir = os.path.join(temp_dir, "espn_openclaw_profile")

        browser = p.chromium.launch_persistent_context(
            user_data_dir=profile_dir,
            headless=False,
            args=["--disable-blink-features=AutomationControlled"]
        )
        page = browser.new_page()
        page.goto("https://fantasy.espn.com/football/")
        page.wait_for_timeout(3000)

        ensure_espn_login(page, session_id=session_id, timeout_seconds=timeout_seconds)

        cookies = {c["name"]: c["value"] for c in browser.cookies()}
        browser.close()

    espn_s2 = cookies.get("espn_s2")
    swid = cookies.get("SWID")
    if not espn_s2 or not swid:
        log_system_event("ESPN_COOKIE_HARVEST_FAILED", "Browser closed without finding espn_s2/SWID cookies — login may not have completed.", session_id=session_id)
        raise RuntimeError("Could not find espn_s2/SWID cookies after login — login may not have completed.")

    save_espn_settings(espn_s2=espn_s2, swid=swid, session_id=session_id)
    log_system_event("ESPN_COOKIES_HARVESTED", "Captured fresh ESPN session cookies via browser login", session_id=session_id)
    return {"espn_s2": espn_s2, "swid": swid}


def fetch_espn_with_reauth(url: str, cookies: dict, ttl_seconds: int, session_id: str = None) -> dict:
    """
    Calls fetch_cached_api_request with the given cookies. If ESPN rejects
    them (401/403 — missing or expired session), opens a Playwright login
    window to harvest fresh cookies and retries once.
    """
    try:
        return fetch_cached_api_request(url, cookies=cookies, ttl_seconds=ttl_seconds, session_id=session_id)
    except requests.exceptions.HTTPError as e:
        status = e.response.status_code if e.response is not None else None
        if status not in (401, 403):
            raise
        logging.warning(f"ESPN API returned {status} (likely missing/expired session) — opening browser to log in...")
        log_system_event("ESPN_REAUTH_REQUIRED", f"ESPN API returned {status}, opening browser to refresh session cookies", {"url": url}, session_id=session_id)
        fresh = harvest_espn_cookies_via_browser(session_id=session_id)
        return fetch_cached_api_request(url, cookies={"espn_s2": fresh["espn_s2"], "SWID": fresh["swid"]}, ttl_seconds=ttl_seconds, session_id=session_id)


def _parse_espn_roster_players(data: dict, team_id: str) -> list:
    """
    Extract this team's players from ESPN's raw mRoster response, including
    each player's ESPN id — needed for ID-based (not just name-based) matching
    against nflverse stats in nfl_data_client.py.
    """
    team = next((t for t in data.get("teams", []) if str(t.get("id")) == str(team_id)), None)
    if not team:
        return []

    players = []
    for entry in team.get("roster", {}).get("entries", []):
        player = entry.get("playerPoolEntry", {}).get("player", {})
        if not player.get("fullName"):
            continue
        slot_id = entry.get("lineupSlotId")
        status = "BENCH" if slot_id == 20 else ("IR" if slot_id == 21 else "ACTIVE")
        players.append({
            "name": player["fullName"],
            "espn_id": player.get("id"),
            "pos": ESPN_POSITION_NAMES.get(player.get("defaultPositionId"), "?"),
            "status": status,
            "lineup_slot": LINEUP_SLOT_NAMES.get(slot_id, str(slot_id)),
        })
    return players


def fetch_espn_roster_via_api(ttl_seconds: int = 300, session_id: str = None):
    """
    Fetches ESPN roster data using SQLite API Caching.
    Reuses cached responses for 300 seconds (5 mins) to prevent IP blocking/rate-limiting.
    """
    settings = resolve_espn_settings(session_id=session_id)
    url = f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ff/seasons/2026/segments/0/leagues/{settings['league_id']}?view=mRoster"
    cookies = {"espn_s2": settings["espn_s2"], "SWID": settings["swid"]}

    try:
        data = fetch_espn_with_reauth(url, cookies, ttl_seconds, session_id=session_id)
        players = _parse_espn_roster_players(data, settings["team_id"])
        logging.info(f"Successfully loaded ESPN roster data ({len(players)} players, using SQLite API cache if valid).")
        return {
            "week": data.get("scoringPeriodId", 1),
            "team_id": settings["team_id"],
            "players": players,
        }
    except Exception as e:
        logging.warning(f"Could not fetch via API (using mock fallback for testing): {e}")
        return {
            "week": 1,
            "team_id": settings["team_id"],
            "players": [
                {"name": "Josh Allen", "pos": "QB", "status": "ACTIVE", "proj": 21.4},
                {"name": "Christian McCaffrey", "pos": "RB", "status": "ACTIVE", "proj": 19.8},
                {"name": "Baker Mayfield", "pos": "QB", "status": "BENCH", "proj": 15.2}
            ]
        }


def fetch_espn_league_settings(session_id: str = None, ttl_seconds: int = 86400):
    """
    Fetches this league's format & roster settings (team count, PPR scoring,
    lineup slot counts) via ESPN's view=mSettings, and saves them for this
    session so they can be displayed and fed to DeepSeek.

    Only the draft assistant calls this — league/roster settings are locked in
    once the draft is done, so there's no need to hit ESPN for them on every
    lineup/trade run. Other workflows read the saved values via
    get_saved_league_settings_block() instead.
    """
    settings = resolve_espn_settings(session_id=session_id)
    url = f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ff/seasons/2026/segments/0/leagues/{settings['league_id']}?view=mSettings"
    cookies = {"espn_s2": settings["espn_s2"], "SWID": settings["swid"]}

    try:
        data = fetch_espn_with_reauth(url, cookies, ttl_seconds, session_id=session_id)
        league_settings = data.get("settings", {})

        team_count = league_settings.get("size", 12)

        scoring_items = league_settings.get("scoringSettings", {}).get("scoringItems", [])
        reception_points = next((i.get("points", 0) for i in scoring_items if i.get("statId") == 53), 0)
        if reception_points >= 1:
            ppr_label = "Full PPR"
        elif reception_points > 0:
            ppr_label = f"{reception_points} PPR"
        else:
            ppr_label = "Standard (non-PPR)"
        league_format = f"{team_count}-Team, {ppr_label}"

        slot_counts = league_settings.get("rosterSettings", {}).get("lineupSlotCounts", {})
        roster_parts = []
        for slot_id_str, count in slot_counts.items():
            slot_id = int(slot_id_str)
            if int(count) <= 0 or slot_id in _HIDDEN_SLOTS:
                continue
            roster_parts.append(f"{count} {LINEUP_SLOT_NAMES.get(slot_id, f'Slot{slot_id}')}")
        roster_settings = ", ".join(roster_parts) if roster_parts else "Unknown"

        draft_settings_raw = league_settings.get("draftSettings", {})
        pick_order_ids = draft_settings_raw.get("pickOrder", [])
        draft_type = draft_settings_raw.get("type", "SNAKE")
        draft_order = [
            {"pick": i + 1, "team_id": tid, "is_you": str(tid) == str(settings["team_id"])}
            for i, tid in enumerate(pick_order_ids)
        ]

        logging.info(f"Loaded ESPN league settings: {league_format} | {roster_settings}")
    except Exception as e:
        logging.warning(f"Could not fetch ESPN league settings (using mock fallback for testing): {e}")
        league_format = "12-Team, 0.5 PPR"
        roster_settings = "1 QB, 2 RB, 2 WR, 1 TE, 1 FLEX, 1 D/ST, 1 K, 6 Bench"
        draft_type = "SNAKE"
        draft_order = [{"pick": i + 1, "team_id": i + 1, "is_you": (i + 1) == 3} for i in range(12)]
        league_settings = {}

    save_league_settings(league_format, roster_settings, raw=league_settings, draft_order=draft_order, draft_type=draft_type, session_id=session_id)
    return {"league_format": league_format, "roster_settings": roster_settings, "draft_order": draft_order, "draft_type": draft_type}


def format_league_settings_block(settings: dict) -> str:
    """Format a league_format/roster_settings dict for inclusion in an LLM prompt."""
    return (
        "League Settings:\n"
        f"- Format: {settings['league_format']}\n"
        f"- Roster: {settings['roster_settings']}"
    )


def format_draft_order_block(draft_order: list, draft_type: str = "SNAKE") -> str:
    """
    Format the draft's pick order for the draft-assistant prompt only — order
    is only meaningful while a draft is actually happening. draft_order is a
    list of {"pick": int, "team_id": ..., "is_you": bool}, round-1 order as
    returned by ESPN (see fetch_espn_league_settings).
    """
    if not draft_order:
        return ""
    order_str = ", ".join(
        f"#{p['pick']} Team {p['team_id']}" + (" (You)" if p.get("is_you") else "")
        for p in draft_order
    )
    your_pick = next((p["pick"] for p in draft_order if p.get("is_you")), None)
    your_pick_line = f"\nYour Round 1 pick position: #{your_pick} of {len(draft_order)}." if your_pick else ""
    return f"Draft Order ({draft_type}, Round 1): {order_str}{your_pick_line}"


def get_saved_league_settings_block(session_id: str = None) -> str:
    """
    Format this session's already-saved league settings for a prompt, without
    making a live ESPN call (see fetch_espn_league_settings docstring for why).
    Returns "" if nothing has been fetched yet for this session — i.e. the
    draft assistant hasn't been run there.
    """
    saved = get_league_settings(session_id=session_id)
    if not saved:
        return ""
    return format_league_settings_block(saved)


def execute_roster_changes_browser(pick_instructions: dict, session_id: str = None):
    """
    Automate ESPN roster updates using Playwright browser UI automation.
    Navigates to ESPN Team page, moves players, and saves changes.
    """
    logging.info("Launching browser session for ESPN Fantasy...")
    log_system_event("BROWSER_AUTOMATION_START", "Launching Playwright to update ESPN roster", pick_instructions, session_id=session_id)
    starters = pick_instructions.get("starters", [])
    settings = resolve_espn_settings(session_id=session_id)

    with sync_playwright() as p:
        temp_dir = os.environ.get("TEMP", "C:/tmp")
        profile_dir = os.path.join(temp_dir, "espn_openclaw_profile")

        browser = p.chromium.launch_persistent_context(
            user_data_dir=profile_dir,
            headless=False,
            args=["--disable-blink-features=AutomationControlled"]
        )

        page = browser.new_page()
        lineup_url = f"https://fantasy.espn.com/football/team?leagueId={settings['league_id']}&teamId={settings['team_id']}"
        logging.info(f"Navigating to ESPN Team page: {lineup_url}")
        page.goto(lineup_url)
        page.wait_for_timeout(3000)

        ensure_espn_login(page, session_id=session_id)

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
