import datetime
import os
import re
import json
import logging
import threading
import requests
from playwright.sync_api import sync_playwright
from src.helpers.db_manager import (
    fetch_cached_api_request, log_system_event, save_league_settings, get_league_settings,
    get_espn_settings, save_espn_settings,
)
from src.helpers.constants import ESPN_LEAGUE_ID, ESPN_TEAM_ID, ESPN_S2, SWID
from src.helpers.playwright_runner import playwright_sync


def espn_season() -> int:
    return int(os.getenv("ESPN_SEASON", datetime.datetime.now().year))


def league_api_url(league_id: str, view: str, season: int = None) -> str:
    """ESPN fantasy football league reads use games/ffl (not games/ff)."""
    season = season or espn_season()
    return (
        f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/"
        f"segments/0/leagues/{league_id}?view={view}"
    )


def cookies_look_valid(settings: dict) -> bool:
    s2 = (settings.get("espn_s2") or "").strip()
    swid = (settings.get("swid") or "").strip()
    if not s2 or not swid:
        return False
    blob = f"{s2} {swid}".lower()
    if any(tok in blob for tok in ("your_espn", "your_swid", "cookie_here", "placeholder")):
        return False
    return True


def request_cookies(settings: dict) -> dict:
    return {"espn_s2": settings.get("espn_s2") or "", "SWID": settings.get("swid") or ""}


def _name_from_espn_pick(pick: dict) -> str:
    """Best-effort display name from an mDraftDetail pick object."""
    if not isinstance(pick, dict):
        return ""
    for key in ("playerName", "fullName", "name"):
        val = pick.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    player = pick.get("player") if isinstance(pick.get("player"), dict) else {}
    for key in ("fullName", "name", "displayName"):
        val = player.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    first = (player.get("firstName") or "").strip()
    last = (player.get("lastName") or "").strip()
    if first or last:
        return f"{first} {last}".strip()
    entry = pick.get("playerPoolEntry") if isinstance(pick.get("playerPoolEntry"), dict) else {}
    nested = entry.get("player") if isinstance(entry.get("player"), dict) else {}
    for key in ("fullName", "name", "displayName"):
        val = nested.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    first = (nested.get("firstName") or "").strip()
    last = (nested.get("lastName") or "").strip()
    if first or last:
        return f"{first} {last}".strip()
    return ""


def _pos_from_espn_pick(pick: dict) -> str:
    """Best-effort position from an mDraftDetail pick / player object."""
    if not isinstance(pick, dict):
        return ""
    nested_entry = pick.get("playerPoolEntry") if isinstance(pick.get("playerPoolEntry"), dict) else {}
    nested_player = nested_entry.get("player") if isinstance(nested_entry.get("player"), dict) else {}
    for obj in (
        pick,
        pick.get("player") if isinstance(pick.get("player"), dict) else {},
        nested_entry,
        nested_player,
    ):
        if not isinstance(obj, dict):
            continue
        raw = obj.get("defaultPositionId")
        if raw is None:
            continue
        try:
            return ESPN_POSITION_NAMES.get(int(raw), "") or ""
        except (TypeError, ValueError):
            continue
    return ""


# session_id -> {espn_id str: {"name": str, "pos": str}}. Player identities do not
# change during a dashboard session, so resolved names/positions are reused.
_PLAYER_ID_CACHE_LOCK = threading.Lock()
_PLAYER_ID_CACHE: dict = {}
_NFLVERSE_ID_NAMES = None


def _nflverse_espn_id_names() -> dict:
    """espn_id str -> display name. Loaded once; IDs do not change mid-session."""
    global _NFLVERSE_ID_NAMES
    if _NFLVERSE_ID_NAMES is not None:
        return _NFLVERSE_ID_NAMES
    try:
        from src.helpers.nfl_data_client import get_espn_id_to_name
        _NFLVERSE_ID_NAMES = get_espn_id_to_name() or {}
    except Exception as e:
        logging.warning(f"Could not load ESPN id→name crosswalk: {e}")
        _NFLVERSE_ID_NAMES = {}
    return _NFLVERSE_ID_NAMES


def remember_espn_player(session_id: str, player_id, name: str = "", pos: str = "") -> None:
    """Cache a playerId → name/pos mapping for the rest of this session."""
    try:
        key = str(int(player_id))
    except (TypeError, ValueError):
        return
    name = (name or "").strip()
    pos = (pos or "").strip()
    if not name and not pos:
        return
    sid = session_id or ""
    with _PLAYER_ID_CACHE_LOCK:
        cache = _PLAYER_ID_CACHE.setdefault(sid, {})
        prev = cache.get(key) or {}
        cache[key] = {
            "name": name or prev.get("name") or "",
            "pos": pos or prev.get("pos") or "",
        }


def cached_espn_player(session_id: str, player_id) -> dict:
    try:
        key = str(int(player_id))
    except (TypeError, ValueError):
        return {}
    with _PLAYER_ID_CACHE_LOCK:
        return dict((_PLAYER_ID_CACHE.get(session_id or "") or {}).get(key) or {})


def resolve_draft_pick_identities(picks: list, session_id: str = None) -> list:
    """
    Fill blank pick names/positions from the session playerId cache, then the
    nflverse ESPN-id crosswalk. Newly resolved identities stay cached for the
    whole session.
    """
    nflverse = _nflverse_espn_id_names()
    sid = session_id or ""
    with _PLAYER_ID_CACHE_LOCK:
        cache = _PLAYER_ID_CACHE.setdefault(sid, {})
        for pick in picks or []:
            if not isinstance(pick, dict):
                continue
            pid = pick.get("player_id")
            if not pid:
                continue
            try:
                key = str(int(pid))
            except (TypeError, ValueError):
                continue
            cached = cache.get(key) or {}
            name = (pick.get("name") or "").strip() or cached.get("name") or nflverse.get(key) or ""
            pos = (pick.get("pos") or "").strip() or cached.get("pos") or ""
            if name or pos:
                cache[key] = {
                    "name": name or cached.get("name") or "",
                    "pos": pos or cached.get("pos") or "",
                }
            pick["name"] = name or (cache.get(key) or {}).get("name") or ""
            pick["pos"] = pos or (cache.get(key) or {}).get("pos") or ""
    return picks


def fetch_drafted_player_ids(session_id: str = None, ttl_seconds: int = 15, league_id: str = None) -> list:
    """
    Return ESPN playerIds already selected in this league's draft
    (mDraftDetail picks where playerId > 0). Short TTL so live drafts stay fresh.
    """
    return [
        p["player_id"]
        for p in fetch_draft_picks_detail(session_id=session_id, ttl_seconds=ttl_seconds, league_id=league_id)
        if p.get("player_id")
    ]


def fetch_draft_picks_detail(session_id: str = None, ttl_seconds: int = 15, league_id: str = None) -> list:
    """
    Return live draft picks from mDraftDetail as
    [{"overall", "team_id", "player_id", "name"}, ...] for completed picks
    (playerId > 0). Overall is 1-based when ESPN provides pick order; otherwise
    list order is used.
    """
    settings = resolve_espn_settings(session_id=session_id)
    lid = league_id or settings["league_id"]
    url = league_api_url(lid, "mDraftDetail")
    cookies = request_cookies(settings)
    try:
        data = fetch_espn_with_reauth(url, cookies, ttl_seconds=ttl_seconds, session_id=session_id)
    except Exception as e:
        logging.warning(f"Could not fetch mDraftDetail for draft picks: {e}")
        return []
    return resolve_draft_pick_identities(
        parse_draft_picks_from_payload(data),
        session_id=session_id,
    )


def parse_draft_picks_from_payload(data: dict) -> list:
    """Normalize ESPN draftDetail.picks (and nested player maps) into pick dicts."""
    if not isinstance(data, dict):
        return []
    draft_detail = data.get("draftDetail") or data.get("draft") or {}
    picks = (draft_detail.get("picks") if isinstance(draft_detail, dict) else None) or data.get("picks") or []
    players_by_id = {}
    for src in (data.get("players"), (draft_detail or {}).get("players")):
        if isinstance(src, dict):
            for k, v in src.items():
                players_by_id[str(k)] = v
        elif isinstance(src, list):
            for p in src:
                if not isinstance(p, dict):
                    continue
                pid = p.get("id") or p.get("playerId") or (p.get("player") or {}).get("id")
                if pid:
                    players_by_id[str(pid)] = p

    out = []
    for i, pick in enumerate(picks if isinstance(picks, list) else []):
        if not isinstance(pick, dict):
            continue
        try:
            pid = int(pick.get("playerId") or pick.get("player") or 0)
        except (TypeError, ValueError):
            pid = 0
        if pid <= 0:
            continue
        try:
            team_id = int(pick.get("teamId") or 0)
        except (TypeError, ValueError):
            team_id = 0
        overall = (
            pick.get("overallPickNumber")
            or pick.get("pickNumber")
            or pick.get("absolutePickNumber")
        )
        if overall is None:
            try:
                round_id = int(pick.get("roundId"))
                round_pick = int(pick.get("roundPickNumber") or 0)
                team_count = int(pick.get("teamCount") or 0)
                if team_count > 0 and round_pick > 0:
                    overall = round_id * team_count + round_pick
            except (TypeError, ValueError):
                overall = None
        if overall is None:
            overall = pick.get("id")
        try:
            overall = int(overall) if overall is not None else (i + 1)
        except (TypeError, ValueError):
            overall = i + 1
        name = _name_from_espn_pick(pick)
        pos = _pos_from_espn_pick(pick)
        mapped = players_by_id.get(str(pid))
        if isinstance(mapped, dict):
            if not name:
                name = _name_from_espn_pick(mapped) or _name_from_espn_pick({"player": mapped.get("player") or mapped})
            if not pos:
                pos = _pos_from_espn_pick(mapped) or _pos_from_espn_pick(mapped.get("player") or {})
        out.append({
            "overall": overall,
            "team_id": team_id,
            "player_id": pid,
            "name": name or "",
            "pos": pos or "",
        })
    out.sort(key=lambda p: p["overall"])
    return out


def fetch_team_draft_strategy(session_id: str = None, ttl_seconds: int = 60) -> dict:
    """
    Read this team's ESPN draftStrategy (draftList + roundStrategy) via mTeam.
    Returns {"draft_list": [playerId, ...], "round_strategy": [...], "team_id": ...}.
    """
    settings = resolve_espn_settings(session_id=session_id)
    url = league_api_url(settings["league_id"], "mTeam")
    cookies = request_cookies(settings)
    try:
        data = fetch_espn_with_reauth(url, cookies, ttl_seconds=ttl_seconds, session_id=session_id)
    except Exception as e:
        logging.warning(f"Could not fetch mTeam draftStrategy: {e}")
        return {"draft_list": [], "round_strategy": [], "team_id": settings.get("team_id")}

    team_id = str(settings.get("team_id") or "")
    team = next((t for t in (data.get("teams") or []) if str(t.get("id")) == team_id), None)
    if not team:
        return {"draft_list": [], "round_strategy": [], "team_id": team_id}

    strategy = team.get("draftStrategy") or {}
    draft_list = []
    for entry in strategy.get("draftList") or []:
        try:
            pid = int(entry.get("playerId") or 0)
        except (TypeError, ValueError):
            continue
        if pid > 0:
            draft_list.append(pid)
    return {
        "draft_list": draft_list,
        "round_strategy": list(strategy.get("roundStrategy") or []),
        "position_strategy": list(strategy.get("positionStrategy") or []),
        "excluded_player_ids": list(strategy.get("excludedPlayerIds") or []),
        "team_id": team_id,
    }


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


@playwright_sync
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
    Also harvests first when cookies are missing/placeholder so we don't
    burn a doomed request against a private league.
    """
    if not cookies_look_valid({"espn_s2": (cookies or {}).get("espn_s2"), "swid": (cookies or {}).get("SWID")}):
        logging.warning("ESPN cookies missing/placeholder — opening browser to log in...")
        log_system_event(
            "ESPN_REAUTH_REQUIRED",
            "ESPN cookies missing or placeholder; opening browser to harvest session cookies",
            {"url": url},
            session_id=session_id,
        )
        fresh = harvest_espn_cookies_via_browser(session_id=session_id)
        cookies = {"espn_s2": fresh["espn_s2"], "SWID": fresh["swid"]}

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
    url = league_api_url(settings["league_id"], "mRoster")
    cookies = request_cookies(settings)

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


def draft_slot_band(slot: int, team_count: int) -> str:
    """Map a 1-based round-1 slot to early / middle / late (scaled from 12-team 1–4 / 5–8 / 9–12)."""
    try:
        slot = int(slot)
        team_count = int(team_count)
    except (TypeError, ValueError):
        return ""
    if slot < 1 or team_count < 1:
        return ""
    early_end = max(1, int(round(team_count * 4 / 12)))
    middle_end = max(early_end, int(round(team_count * 8 / 12)))
    if slot <= early_end:
        return "early"
    if slot <= middle_end:
        return "middle"
    return "late"


def snake_overall_picks(slot: int, team_count: int, rounds: int = 18) -> list:
    """1-based overall pick numbers this slot owns in a snake draft."""
    try:
        slot = int(slot)
        team_count = int(team_count)
        rounds = int(rounds)
    except (TypeError, ValueError):
        return []
    if slot < 1 or team_count < 1 or rounds < 1:
        return []
    out = []
    for rnd in range(1, rounds + 1):
        if rnd % 2 == 1:
            overall = (rnd - 1) * team_count + slot
        else:
            overall = (rnd - 1) * team_count + (team_count + 1 - slot)
        out.append(overall)
    return out


def snake_picks_until_next(slot: int, team_count: int, current_overall: int, draft_type: str = "SNAKE"):
    """Selections that will happen after this pick before this slot is on the clock again."""
    try:
        current_overall = int(current_overall)
        team_count = int(team_count)
        slot = int(slot)
    except (TypeError, ValueError):
        return None
    if team_count < 1 or slot < 1 or current_overall < 1:
        return None
    if (draft_type or "SNAKE").upper() != "SNAKE":
        return max(0, team_count - 1)
    upcoming = [p for p in snake_overall_picks(slot, team_count) if p >= current_overall]
    if len(upcoming) < 2:
        return None
    return upcoming[1] - upcoming[0] - 1


def _team_display_name(team: dict) -> str:
    loc = (team.get("location") or "").strip()
    nick = (team.get("nickname") or "").strip()
    name = (team.get("name") or "").strip()
    abbrev = (team.get("abbrev") or "").strip()
    if loc and nick:
        return f"{loc} {nick}".strip()
    return name or abbrev or f"Team {team.get('id')}"


def _fetch_team_labels(session_id: str = None, ttl_seconds: int = 86400) -> dict:
    """Map team_id string -> display name from mTeam."""
    settings = resolve_espn_settings(session_id=session_id)
    url = league_api_url(settings["league_id"], "mTeam")
    cookies = request_cookies(settings)
    try:
        data = fetch_espn_with_reauth(url, cookies, ttl_seconds, session_id=session_id)
    except Exception as e:
        logging.warning(f"Could not load team names for pick order: {e}")
        return {}
    labels = {}
    for team in data.get("teams") or []:
        if not isinstance(team, dict) or team.get("id") is None:
            continue
        labels[str(team.get("id"))] = _team_display_name(team)
    return labels


def _round1_order_from_draft_detail(data: dict, team_count: int) -> list:
    """Round-1 team order from mDraftDetail picks (includes empty slots)."""
    if not isinstance(data, dict) or team_count < 1:
        return []
    draft_detail = data.get("draftDetail") or data.get("draft") or {}
    picks = (draft_detail.get("picks") if isinstance(draft_detail, dict) else None) or data.get("picks") or []
    rows = []
    for pick in picks if isinstance(picks, list) else []:
        if not isinstance(pick, dict) or pick.get("teamId") is None:
            continue
        overall = pick.get("overallPickNumber") or pick.get("pickNumber") or pick.get("id")
        try:
            overall = int(overall) if overall is not None else 0
        except (TypeError, ValueError):
            overall = 0
        try:
            round_id = int(pick.get("roundId")) if pick.get("roundId") is not None else None
        except (TypeError, ValueError):
            round_id = None
        if round_id not in (None, 0, 1) and overall > team_count:
            continue
        if overall < 1 or overall > team_count:
            continue
        rows.append({"pick": overall, "team_id": pick.get("teamId")})
    by_pick = {}
    for row in rows:
        by_pick[row["pick"]] = row["team_id"]
    if len(by_pick) < team_count:
        return []
    return [{"pick": i, "team_id": by_pick[i]} for i in range(1, team_count + 1)]


def fetch_espn_league_settings(session_id: str = None, ttl_seconds: int = 86400):
    """
    Fetches this league's format, roster settings, and round-1 pick order via
    ESPN mSettings (mTeam names, mDraftDetail fallback if pickOrder is empty),
    and saves them for this session so they can be displayed and fed to DeepSeek.

    Setup Draft Strategy and live/mock draft call this. Lineup/trade runs read
    the saved values via get_saved_league_settings_block() instead.
    """
    settings = resolve_espn_settings(session_id=session_id)
    url = league_api_url(settings["league_id"], "mSettings")
    cookies = request_cookies(settings)

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
        pick_order_ids = draft_settings_raw.get("pickOrder") or []
        draft_type = draft_settings_raw.get("type", "SNAKE")
        team_labels = _fetch_team_labels(session_id=session_id, ttl_seconds=ttl_seconds)
        if not pick_order_ids:
            try:
                detail_url = league_api_url(settings["league_id"], "mDraftDetail")
                detail = fetch_espn_with_reauth(detail_url, cookies, ttl_seconds=30, session_id=session_id)
                pick_order_ids = [
                    row["team_id"]
                    for row in _round1_order_from_draft_detail(detail, team_count)
                ]
            except Exception as e:
                logging.warning(f"Could not derive pick order from draft detail: {e}")
        you_id = str(settings["team_id"])
        draft_order = [
            {
                "pick": i + 1,
                "team_id": tid,
                "team_name": team_labels.get(str(tid)) or f"Team {tid}",
                "is_you": str(tid) == you_id,
            }
            for i, tid in enumerate(pick_order_ids)
        ]
        if not draft_order:
            prev = get_league_settings(session_id=session_id) or {}
            draft_order = prev.get("draft_order_json") or []
            draft_type = draft_type or prev.get("draft_type") or "SNAKE"

        your_slot = next((p["pick"] for p in draft_order if p.get("is_you")), None)
        band = draft_slot_band(your_slot, len(draft_order)) if your_slot else ""
        slot_note = f" | Pick #{your_slot} of {len(draft_order)}" + (f" ({band})" if band else "") if your_slot else ""
        logging.info(f"Loaded ESPN league settings: {league_format} | {roster_settings}{slot_note}")
    except Exception as e:
        logging.warning(f"Could not fetch ESPN league settings (using mock fallback for testing): {e}")
        league_format = "12-Team, 0.5 PPR"
        roster_settings = "1 QB, 2 RB, 2 WR, 1 TE, 1 FLEX, 1 D/ST, 1 K, 6 Bench"
        draft_type = "SNAKE"
        draft_order = [{"pick": i + 1, "team_id": i + 1, "team_name": f"Team {i + 1}", "is_you": (i + 1) == 3} for i in range(12)]
        league_settings = {}

    save_league_settings(league_format, roster_settings, raw=league_settings, draft_order=draft_order, draft_type=draft_type, session_id=session_id)
    return {
        "league_format": league_format,
        "roster_settings": roster_settings,
        "draft_order": draft_order,
        "draft_type": draft_type,
        "raw": league_settings,
    }


# Matches the Edit Pre-Draft Strategy "Health → IR-Eligible" filter (O / IR badges).
_ESPN_IR_ELIGIBLE_STATUSES = {
    "OUT",
    "INJURY_RESERVE",
}

_ESPN_INJURY_LABELS = {
    "OUT": "Out",
    "INJURY_RESERVE": "IR",
    "DOUBTFUL": "Doubtful",
    "QUESTIONABLE": "Questionable",
    "SUSPENSION": "Suspension",
    "ACTIVE": "ACTIVE",
}


def fetch_espn_ir_eligible_players(session_id: str = None, ttl_seconds: int = 900) -> dict:
    """
    Pull ESPN injury designations used by the Pre-Draft Strategy "IR-Eligible"
    health filter (Out / Injured Reserve).

    Returns:
      {
        espn_id(str): {
          "name": str,
          "injury_status": "Out"|"IR"|"Questionable"|...,
          "injury_status_raw": str,
          "ir_eligible": bool,   # True only for Out / IR (site IR-Eligible list)
        }
      }

    Non-ACTIVE designations (including Questionable) are included so callers can
    label milder statuses; only ir_eligible=True matches the site filter.
    """
    import hashlib
    import time as _time
    from src.helpers.db_manager import get_db_connection

    settings = resolve_espn_settings(session_id=session_id)
    season = espn_season()
    url = (
        f"https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/"
        f"players?scoringPeriodId=0&view=kona_player_info"
    )
    cache_url = url + "&filter=ir_eligible_v1"
    cookies = request_cookies(settings)
    headers = {
        "x-fantasy-filter": json.dumps({
            "players": {
                "limit": 5000,
                "sortPercOwned": {"sortAsc": False, "sortPriority": 1},
            }
        }),
        "x-fantasy-platform": "espn-fantasy-web",
        "x-fantasy-source": "kona",
    }

    data = None
    url_hash = hashlib.sha256(cache_url.encode("utf-8")).hexdigest()
    now_ts = int(_time.time())
    try:
        conn = get_db_connection(session_id)
        row = conn.execute(
            "SELECT response_json, timestamp, ttl_seconds FROM api_cache WHERE url_hash = ?",
            (url_hash,),
        ).fetchone()
        conn.close()
        if row and (now_ts - row["timestamp"]) < row["ttl_seconds"]:
            data = json.loads(row["response_json"])
            log_system_event(
                "API_CACHE_HIT",
                "Reused cached ESPN IR-Eligible / injury feed",
                {"url": cache_url, "age_seconds": now_ts - row["timestamp"]},
                session_id=session_id,
            )
    except Exception as e:
        logging.warning(f"ESPN IR cache read failed: {e}")

    if data is None:
        log_system_event(
            "ESPN_IR_ELIGIBLE_FETCH",
            "Fetching ESPN player injury feed (IR-Eligible source)",
            {"url": url},
            session_id=session_id,
        )
        res = requests.get(url, cookies=cookies, headers=headers, timeout=60)
        res.raise_for_status()
        data = res.json()
        try:
            conn = get_db_connection(session_id)
            conn.execute(
                """
                INSERT OR REPLACE INTO api_cache (url_hash, url, response_json, timestamp, ttl_seconds)
                VALUES (?, ?, ?, ?, ?)
                """,
                (url_hash, cache_url, json.dumps(data), now_ts, ttl_seconds),
            )
            conn.commit()
            conn.close()
        except Exception as e:
            logging.warning(f"Could not cache ESPN injury feed: {e}")

    arr = data if isinstance(data, list) else (data.get("players") or [])
    out = {}
    ir_count = 0
    for entry in arr:
        player = entry.get("player", entry) if isinstance(entry, dict) else {}
        espn_id = player.get("id")
        if not espn_id:
            continue
        raw = (player.get("injuryStatus") or "").upper()
        if not raw or raw in ("NONE", "MISSING"):
            raw = "OUT" if player.get("injured") else "ACTIVE"
        if raw == "ACTIVE":
            continue
        label = _ESPN_INJURY_LABELS.get(raw, raw.title().replace("_", " "))
        ir_eligible = raw in _ESPN_IR_ELIGIBLE_STATUSES
        if ir_eligible:
            ir_count += 1
        out[str(int(espn_id))] = {
            "name": player.get("fullName")
            or f"{player.get('firstName', '')} {player.get('lastName', '')}".strip(),
            "injury_status": label,
            "injury_status_raw": raw,
            "ir_eligible": ir_eligible,
        }

    log_system_event(
        "ESPN_IR_ELIGIBLE_LOADED",
        f"Loaded ESPN injury designations ({ir_count} IR-Eligible Out/IR)",
        {"ir_eligible_count": ir_count, "designated_count": len(out)},
        session_id=session_id,
    )
    logging.info(
        f"ESPN IR-Eligible: {ir_count} players (Out/IR); "
        f"{len(out)} total non-ACTIVE designations."
    )
    return out


def format_league_settings_block(settings: dict) -> str:
    """Format a league_format/roster_settings dict for inclusion in an LLM prompt."""
    return (
        "League Settings:\n"
        f"- Format: {settings['league_format']}\n"
        f"- Roster: {settings['roster_settings']}"
    )


def format_draft_order_block(draft_order: list, draft_type: str = "SNAKE") -> str:
    """
    Format the saved round-1 pick order for prompts. draft_order is a list of
    {"pick", "team_id", "team_name"?, "is_you"} from fetch_espn_league_settings.
    """
    if not draft_order:
        return ""
    n = len(draft_order)
    dtype = (draft_type or "SNAKE").upper()
    parts = []
    for p in draft_order:
        label = (p.get("team_name") or f"Team {p.get('team_id')}").strip()
        you = " (You)" if p.get("is_you") else ""
        parts.append(f"#{p['pick']} {label}{you}")
    your_pick = next((p["pick"] for p in draft_order if p.get("is_you")), None)
    band = draft_slot_band(your_pick, n) if your_pick else ""
    lines = [f"Draft Order ({dtype}, Round 1): {', '.join(parts)}"]
    if your_pick:
        wait = snake_picks_until_next(your_pick, n, your_pick, dtype)
        wait_txt = f" After round 1 you wait {wait} selections until your next pick." if wait is not None else ""
        band_txt = f" — {band} slot" if band else ""
        lines.append(f"Your Round 1 pick: #{your_pick} of {n}{band_txt}.{wait_txt}")
        turn = [p for p in draft_order if p.get("pick") in (1, n)]
        if turn:
            turn_txt = ", ".join(
                f"#{p['pick']} {(p.get('team_name') or f'Team {p.get('team_id')}')}"
                + (" (You)" if p.get("is_you") else "")
                for p in turn
            )
            lines.append(f"The turn (first and last slots): {turn_txt}.")
    return "\n".join(lines)


def get_saved_league_settings_block(session_id: str = None) -> str:
    """
    Format this session's already-saved league settings for a prompt, without
    making a live ESPN call (see fetch_espn_league_settings docstring for why).
    Returns "" if nothing has been fetched yet for this session — i.e.
    Setup Draft Strategy hasn't been run there.
    """
    saved = get_league_settings(session_id=session_id)
    if not saved:
        return ""
    return "\n\n".join(filter(None, [
        format_league_settings_block(saved),
        format_draft_order_block(
            saved.get("draft_order_json") or [],
            saved.get("draft_type") or "SNAKE",
        ),
    ]))


@playwright_sync
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
                # filter(has_text=...) avoids CSS quote breakage on names like Ja'Marr Chase
                player_row = page.locator("tr").filter(has_text=player_name)
                if player_row.count() > 0:
                    move_btn = player_row.first.locator("button").filter(has_text=re.compile(r"Move|Swap", re.I))
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
