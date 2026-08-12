import os
import re
import json
import sqlite3
import hashlib
import time
import datetime
import requests

# Root directory of the project
BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ENV_FILE = os.path.join(BASE_DIR, ".env")

# Multi-session SQLite layout: each "session" is its own db file under DATA_DIR,
# registered in SESSIONS_META_FILE. Sessions let you keep e.g. a "Test" db with
# throwaway data separate from your real league's history.
DATA_DIR = os.path.join(BASE_DIR, "data")
SESSIONS_DIR = os.path.join(DATA_DIR, "sessions")
SESSIONS_META_FILE = os.path.join(DATA_DIR, "sessions.json")

# Legacy single-file db from before multi-session support existed. If found on
# first run, it's migrated into the new layout as the "Test" session.
LEGACY_DB_FILE = os.path.join(BASE_DIR, "nfl_history.db")


def load_env():
    """Loads environment variables from root .env file into os.environ."""
    if not os.path.exists(ENV_FILE):
        return
    with open(ENV_FILE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, val = line.split("=", 1)
                os.environ[key.strip()] = val.strip()


# ---------------------------------------------------------------------------
# Session registry
# ---------------------------------------------------------------------------

def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return slug or "session"


def _default_meta() -> dict:
    return {"default_session_id": None, "sessions": []}


def _load_sessions_meta() -> dict:
    os.makedirs(SESSIONS_DIR, exist_ok=True)

    if not os.path.exists(SESSIONS_META_FILE):
        meta = _default_meta()
        if os.path.exists(LEGACY_DB_FILE):
            # One-time migration: move the pre-existing single db file into the
            # new sessions layout, named "Test" since it holds seeded/test data.
            dest = os.path.join(SESSIONS_DIR, "test.db")
            os.replace(LEGACY_DB_FILE, dest)
            meta["sessions"].append({
                "id": "test",
                "name": "Test",
                "filename": "test.db",
                "created_at": datetime.datetime.now().isoformat(),
            })
            meta["default_session_id"] = "test"
        _save_sessions_meta(meta)
        return meta

    with open(SESSIONS_META_FILE, "r", encoding="utf-8") as f:
        meta = json.load(f)

    if not meta.get("sessions"):
        # Meta file exists but has no sessions yet (e.g. legacy db was already
        # migrated then removed) - seed a fresh default "Test" session.
        meta = _default_meta()
        meta["sessions"].append({
            "id": "test",
            "name": "Test",
            "filename": "test.db",
            "created_at": datetime.datetime.now().isoformat(),
        })
        meta["default_session_id"] = "test"
        _save_sessions_meta(meta)

    return meta


def _save_sessions_meta(meta: dict):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(SESSIONS_META_FILE, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)


def list_sessions() -> dict:
    """Return {"sessions": [...], "default_session_id": "..."}."""
    meta = _load_sessions_meta()
    return {"sessions": meta["sessions"], "default_session_id": meta["default_session_id"]}


def create_session(name: str) -> dict:
    """Create a new empty session db file and register it. Returns the new session."""
    name = (name or "").strip()
    if not name:
        raise ValueError("Session name is required")

    meta = _load_sessions_meta()
    existing_ids = {s["id"] for s in meta["sessions"]}
    base_id = _slugify(name)
    session_id = base_id
    suffix = 2
    while session_id in existing_ids:
        session_id = f"{base_id}-{suffix}"
        suffix += 1

    filename = f"{session_id}.db"
    session = {
        "id": session_id,
        "name": name,
        "filename": filename,
        "created_at": datetime.datetime.now().isoformat(),
    }
    meta["sessions"].append(session)
    if not meta.get("default_session_id"):
        meta["default_session_id"] = session_id
    _save_sessions_meta(meta)

    # Initialize an empty schema for the new session's db file.
    init_db(session_id=session_id)
    return session


def set_default_session(session_id: str) -> dict:
    meta = _load_sessions_meta()
    if not any(s["id"] == session_id for s in meta["sessions"]):
        raise ValueError(f"Unknown session id: {session_id}")
    meta["default_session_id"] = session_id
    _save_sessions_meta(meta)
    return {"default_session_id": session_id}


def _resolve_session(session_id: str = None) -> str:
    """Resolve a requested session id to a valid, existing session id."""
    meta = _load_sessions_meta()
    sessions = meta["sessions"]
    if session_id and any(s["id"] == session_id for s in sessions):
        return session_id
    if meta.get("default_session_id") and any(s["id"] == meta["default_session_id"] for s in sessions):
        return meta["default_session_id"]
    return sessions[0]["id"]


def _db_path_for_session(session_id: str = None) -> str:
    meta = _load_sessions_meta()
    resolved_id = _resolve_session(session_id)
    session = next(s for s in meta["sessions"] if s["id"] == resolved_id)
    return os.path.join(SESSIONS_DIR, session["filename"])


# ---------------------------------------------------------------------------
# Database access (all scoped to a session)
# ---------------------------------------------------------------------------

def get_db_connection(session_id: str = None):
    db_path = _db_path_for_session(session_id)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_columns(cursor, table: str, column_defs: dict):
    """Add any columns in column_defs ({name: SQL type}) missing from an existing table."""
    cursor.execute(f"PRAGMA table_info({table})")
    existing = {row[1] for row in cursor.fetchall()}
    for name, sql_type in column_defs.items():
        if name not in existing:
            cursor.execute(f"ALTER TABLE {table} ADD COLUMN {name} {sql_type}")


def init_db(session_id: str = None):
    """Initialize SQLite database schemas for Action Logs, System Activity, and API Cache."""
    conn = get_db_connection(session_id)
    cursor = conn.cursor()

    # 1. Action Logs Table (Stores decision history, prompts sent, & model responses leading to action)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS action_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            week INTEGER,
            action_type TEXT,
            starters TEXT,
            bench TEXT,
            rationale TEXT,
            status TEXT,
            prompt_sent TEXT,
            raw_model_response TEXT
        )
    """)

    # 2. System Activity Logs Table (Detailed logs of all actions taken: API calls, browser clicks, etc.)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS system_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            category TEXT,
            message TEXT,
            details_json TEXT
        )
    """)

    # 3. API Request Cache Table (Prevents IP rate-limiting & blocking on ESPN requests)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS api_cache (
            url_hash TEXT PRIMARY KEY,
            url TEXT,
            response_json TEXT,
            timestamp INTEGER,
            ttl_seconds INTEGER
        )
    """)

    # 4. Suggestions Table (Individual actionable items proposed by an action_log
    #    run, e.g. one "START Josh Allen" per lineup run. The user accepts or
    #    declines each one; only ACCEPTED, executable suggestions ever trigger
    #    a Playwright action.)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS suggestions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action_log_id INTEGER NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            suggestion_type TEXT,
            player TEXT,
            detail_json TEXT,
            status TEXT DEFAULT 'PENDING'
        )
    """)

    # 5. League Settings (Single row per session — this session's league format
    #    & roster rules, fetched from ESPN and fed to DeepSeek for VORP/scarcity
    #    reasoning that actually matches how the league is scored/structured.)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS league_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            league_format TEXT,
            roster_settings TEXT,
            raw_json TEXT,
            draft_order_json TEXT,
            draft_type TEXT,
            fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # 6. Chat Messages (Free-form Q&A with DeepSeek — see chat_client.py. Each
    #    assistant message records its tool_trace so lookups it made along the
    #    way stay visible/auditable, same spirit as prompt_sent/raw_model_response
    #    on action_logs.)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            role TEXT,
            content TEXT,
            tool_trace_json TEXT
        )
    """)

    # 7. ESPN Session (Single row per session — this session's ESPN league id,
    #    team id, and espn_s2/SWID cookies. Cookies can arrive two ways: typed
    #    in manually via the settings form, or harvested via a Playwright login
    #    window (see espn_client.harvest_espn_cookies_via_browser()). Kept
    #    session-scoped and out of .env on purpose — different sessions can be
    #    different leagues/teams, and a shared .env shouldn't accumulate
    #    personal login cookies from ad-hoc browser logins.)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS espn_session (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            league_id TEXT,
            team_id TEXT,
            espn_s2 TEXT,
            swid TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Migrate any pre-existing db files (created before a column existed) in place.
    _ensure_columns(cursor, "league_settings", {"draft_order_json": "TEXT", "draft_type": "TEXT"})
    _ensure_columns(cursor, "action_logs", {"prompt_sent": "TEXT", "raw_model_response": "TEXT"})
    _ensure_columns(cursor, "espn_session", {"league_id": "TEXT", "team_id": "TEXT"})

    conn.commit()
    conn.close()


def log_system_event(category: str, message: str, details: dict = None, session_id: str = None):
    """Log an operational action or system event into system_logs table."""
    init_db(session_id)
    conn = get_db_connection(session_id)
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO system_logs (category, message, details_json)
        VALUES (?, ?, ?)
    """, (category, message, json.dumps(details or {})))
    conn.commit()
    conn.close()


def log_action(week: int, action_type: str, starters: list, bench: list, rationale: str, status: str,
                prompt_sent: str = "", raw_response: str = "", session_id: str = None):
    """Record an action entry in SQLite along with the input prompt and model response."""
    init_db(session_id)
    conn = get_db_connection(session_id)
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO action_logs (week, action_type, starters, bench, rationale, status, prompt_sent, raw_model_response)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        week,
        action_type,
        json.dumps(starters),
        json.dumps(bench),
        rationale,
        status,
        prompt_sent,
        raw_response
    ))
    conn.commit()
    inserted_id = cursor.lastrowid
    conn.close()

    log_system_event("ACTION_COMPLETED", f"Completed action '{action_type}' (#Record {inserted_id})", {
        "record_id": inserted_id,
        "status": status,
        "week": week
    }, session_id=session_id)
    return inserted_id


def update_action_status(action_log_id: int, status: str, session_id: str = None):
    """Update the aggregate status of an action_log row (e.g. once its suggestions have been reviewed/executed)."""
    conn = get_db_connection(session_id)
    cursor = conn.cursor()
    cursor.execute("UPDATE action_logs SET status = ? WHERE id = ?", (status, action_log_id))
    conn.commit()
    conn.close()


def create_suggestions(action_log_id: int, suggestions: list, session_id: str = None) -> list:
    """
    Record a batch of individual, acceptable/declinable suggestions produced by an
    action_log run. Each suggestion dict: {"type": str, "player": str, "detail": dict}.
    Returns the inserted suggestion ids.
    """
    init_db(session_id)
    conn = get_db_connection(session_id)
    cursor = conn.cursor()
    inserted_ids = []
    for s in suggestions:
        cursor.execute("""
            INSERT INTO suggestions (action_log_id, suggestion_type, player, detail_json, status)
            VALUES (?, ?, ?, ?, 'PENDING')
        """, (action_log_id, s.get("type"), s.get("player"), json.dumps(s.get("detail") or {})))
        inserted_ids.append(cursor.lastrowid)
    conn.commit()
    conn.close()
    return inserted_ids


def _row_to_suggestion(row) -> dict:
    item = dict(row)
    try:
        item["detail"] = json.loads(item.pop("detail_json") or "{}")
    except Exception:
        item["detail"] = {}
    return item


def get_suggestions_for_action(action_log_id: int, session_id: str = None) -> list:
    """Retrieve all suggestions tied to a single action_log run."""
    init_db(session_id)
    conn = get_db_connection(session_id)
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM suggestions WHERE action_log_id = ? ORDER BY id ASC", (action_log_id,))
    rows = cursor.fetchall()
    conn.close()
    return [_row_to_suggestion(r) for r in rows]


def get_suggestion(suggestion_id: int, session_id: str = None):
    init_db(session_id)
    conn = get_db_connection(session_id)
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM suggestions WHERE id = ?", (suggestion_id,))
    row = cursor.fetchone()
    conn.close()
    return _row_to_suggestion(row) if row else None


def update_suggestion_status(suggestion_id: int, status: str, session_id: str = None) -> dict:
    """Move a suggestion to ACCEPTED / DECLINED / EXECUTED / EXECUTION_FAILED."""
    init_db(session_id)
    conn = get_db_connection(session_id)
    cursor = conn.cursor()
    cursor.execute("UPDATE suggestions SET status = ? WHERE id = ?", (status, suggestion_id))
    conn.commit()
    conn.close()
    log_system_event("SUGGESTION_STATUS_CHANGED", f"Suggestion #{suggestion_id} -> {status}", {"suggestion_id": suggestion_id, "status": status}, session_id=session_id)
    return get_suggestion(suggestion_id, session_id=session_id)


def get_espn_settings(session_id: str = None):
    """Retrieve this session's saved ESPN connection settings (league id / team id / cookies), or None."""
    init_db(session_id)
    conn = get_db_connection(session_id)
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM espn_session WHERE id = 1")
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None


def save_espn_settings(league_id: str = None, team_id: str = None, espn_s2: str = None, swid: str = None, session_id: str = None) -> dict:
    """
    Upsert this session's ESPN connection settings. Only overwrites fields
    that are explicitly provided (non-None) — the settings form may submit
    only league_id/team_id, and the Playwright cookie harvest only ever knows
    espn_s2/swid, so neither should clobber what the other already saved.
    """
    init_db(session_id)
    existing = get_espn_settings(session_id=session_id) or {}
    merged = {
        "league_id": league_id if league_id is not None else existing.get("league_id"),
        "team_id": team_id if team_id is not None else existing.get("team_id"),
        "espn_s2": espn_s2 if espn_s2 is not None else existing.get("espn_s2"),
        "swid": swid if swid is not None else existing.get("swid"),
    }
    conn = get_db_connection(session_id)
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO espn_session (id, league_id, team_id, espn_s2, swid, updated_at)
        VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
            league_id = excluded.league_id,
            team_id = excluded.team_id,
            espn_s2 = excluded.espn_s2,
            swid = excluded.swid,
            updated_at = CURRENT_TIMESTAMP
    """, (merged["league_id"], merged["team_id"], merged["espn_s2"], merged["swid"]))
    conn.commit()
    conn.close()
    log_system_event("ESPN_SETTINGS_SAVED", "Updated ESPN connection settings for this session", {"fields_updated": [k for k, v in {"league_id": league_id, "team_id": team_id, "espn_s2": espn_s2, "swid": swid}.items() if v is not None]}, session_id=session_id)
    return merged


def save_league_settings(league_format: str, roster_settings: str, raw: dict = None,
                          draft_order: list = None, draft_type: str = None, session_id: str = None):
    """
    Upsert this session's league/draft settings (single row per session db).
    draft_order/draft_type are set whenever league settings are fetched
    (Setup Draft Strategy or Join Live/Mock Draft). league_format/roster_settings
    are reused by lineup/trade prompts too.
    """
    init_db(session_id)
    conn = get_db_connection(session_id)
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO league_settings (id, league_format, roster_settings, raw_json, draft_order_json, draft_type, fetched_at)
        VALUES (1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
            league_format = excluded.league_format,
            roster_settings = excluded.roster_settings,
            raw_json = excluded.raw_json,
            draft_order_json = excluded.draft_order_json,
            draft_type = excluded.draft_type,
            fetched_at = CURRENT_TIMESTAMP
    """, (league_format, roster_settings, json.dumps(raw or {}), json.dumps(draft_order or []), draft_type))
    conn.commit()
    conn.close()


def get_league_settings(session_id: str = None):
    """Retrieve this session's saved league/draft settings, or None if never fetched."""
    init_db(session_id)
    conn = get_db_connection(session_id)
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM league_settings WHERE id = 1")
    row = cursor.fetchone()
    conn.close()
    if not row:
        return None
    item = dict(row)
    try:
        item["draft_order_json"] = json.loads(item["draft_order_json"]) if item["draft_order_json"] else []
    except Exception:
        item["draft_order_json"] = []
    try:
        item["raw_json"] = json.loads(item["raw_json"]) if item["raw_json"] else {}
    except Exception:
        item["raw_json"] = {}
    return item


def fetch_cached_api_request(url: str, cookies: dict = None, ttl_seconds: int = 300, session_id: str = None) -> dict:
    """
    Checks SQLite cache for API responses.
    If valid cache entry exists within TTL, returns cached JSON data (0 HTTP requests sent, 0 IP risk).
    Otherwise, executes HTTP GET, caches response in SQLite, and returns data.

    Caller-supplied ttl_seconds controls freshness: ttl<=0 always fetches fresh.
    Cache validity uses the caller's ttl (not a stale longer TTL from a prior write).
    """
    init_db(session_id)
    url_hash = hashlib.sha256(url.encode("utf-8")).hexdigest()
    now_ts = int(time.time())

    conn = get_db_connection(session_id)
    cursor = conn.cursor()
    cursor.execute("SELECT response_json, timestamp, ttl_seconds FROM api_cache WHERE url_hash = ?", (url_hash,))
    cached = cursor.fetchone()

    if cached and ttl_seconds > 0:
        cached_ts = cached["timestamp"]
        if (now_ts - cached_ts) < ttl_seconds:
            conn.close()
            log_system_event("API_CACHE_HIT", f"Reused cached ESPN API response (0 IP requests sent): {url}", {"url": url, "age_seconds": now_ts - cached_ts}, session_id=session_id)
            return json.loads(cached["response_json"])

    # Cache Miss or Expired -> Perform fresh HTTP GET
    log_system_event("API_CACHE_MISS", f"Fetching fresh API data from ESPN: {url}", {"url": url}, session_id=session_id)
    try:
        res = requests.get(url, cookies=cookies or {}, timeout=10)
        res.raise_for_status()
        res_data = res.json()

        # Save fresh payload to SQLite API Cache (skip store when ttl<=0 so live polls stay fresh)
        store_ttl = max(int(ttl_seconds), 1)
        if ttl_seconds > 0:
            cursor.execute("""
                INSERT OR REPLACE INTO api_cache (url_hash, url, response_json, timestamp, ttl_seconds)
                VALUES (?, ?, ?, ?, ?)
            """, (url_hash, url, json.dumps(res_data), now_ts, store_ttl))
            conn.commit()
            log_system_event("API_CACHE_STORED", f"Cached fresh ESPN API response in SQLite (TTL: {store_ttl}s)", {"url": url}, session_id=session_id)
        conn.close()

        return res_data
    except Exception as e:
        conn.close()
        log_system_event("API_FETCH_ERROR", f"Error requesting ESPN API: {e}", {"url": url, "error": str(e)}, session_id=session_id)
        raise e


def save_chat_message(role: str, content: str, tool_trace: list = None, session_id: str = None) -> int:
    """Record one chat turn ('user' or 'assistant')."""
    init_db(session_id)
    conn = get_db_connection(session_id)
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO chat_messages (role, content, tool_trace_json)
        VALUES (?, ?, ?)
    """, (role, content, json.dumps(tool_trace or [])))
    conn.commit()
    inserted_id = cursor.lastrowid
    conn.close()
    return inserted_id


def get_chat_messages(limit: int = 200, session_id: str = None) -> list:
    """Retrieve this session's chat history, oldest first."""
    init_db(session_id)
    conn = get_db_connection(session_id)
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM chat_messages ORDER BY id DESC LIMIT ?", (limit,))
    rows = cursor.fetchall()
    conn.close()

    result = []
    for r in rows:
        item = dict(r)
        try:
            item["tool_trace_json"] = json.loads(item["tool_trace_json"]) if item["tool_trace_json"] else []
        except Exception:
            item["tool_trace_json"] = []
        result.append(item)
    return list(reversed(result))


def get_all_logs(limit=100, session_id: str = None):
    """Retrieve action history logs as a list of dicts."""
    init_db(session_id)
    conn = get_db_connection(session_id)
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM action_logs ORDER BY timestamp DESC LIMIT ?", (limit,))
    rows = cursor.fetchall()
    conn.close()

    result = []
    for r in rows:
        item = dict(r)
        try:
            item["starters"] = json.loads(item["starters"]) if item["starters"] else []
            item["bench"] = json.loads(item["bench"]) if item["bench"] else []
        except Exception:
            pass
        result.append(item)
    return result


def get_system_logs(limit=100, session_id: str = None):
    """Retrieve detailed system activity & cache logs as a list of dicts."""
    init_db(session_id)
    conn = get_db_connection(session_id)
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM system_logs ORDER BY timestamp DESC LIMIT ?", (limit,))
    rows = cursor.fetchall()
    conn.close()

    result = []
    for r in rows:
        item = dict(r)
        try:
            item["details_json"] = json.loads(item["details_json"]) if item["details_json"] else {}
        except Exception:
            pass
        result.append(item)
    return result


def seed_demo_data_if_empty(session_id: str = None):
    init_db(session_id)
    conn = get_db_connection(session_id)
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) as cnt FROM action_logs")
    cnt = cursor.fetchone()["cnt"]
    conn.close()

    if cnt == 0:
        log_action(
            week=1,
            action_type="LINEUP_OPTIMIZATION",
            starters=["Josh Allen (QB)", "Christian McCaffrey (RB)", "CeeDee Lamb (WR)", "Justin Jefferson (WR)", "Travis Kelce (TE)"],
            bench=["Baker Mayfield (QB)", "Zack Moss (RB)", "Courtland Sutton (WR)"],
            rationale="Started Josh Allen due to high projected point total vs weak secondary. Benched Mayfield.",
            status="SUCCESS",
            prompt_sent="Sample prompt: Analyze roster data and select optimal lineup...",
            raw_response='{"starters": ["Josh Allen"], "bench": ["Baker Mayfield"]}',
            session_id=session_id,
        )


if __name__ == "__main__":
    load_env()
    for s in list_sessions()["sessions"]:
        seed_demo_data_if_empty(session_id=s["id"]) if s["id"] == "test" else None
    print(f"Sessions dir: {SESSIONS_DIR}")
    for s in list_sessions()["sessions"]:
        print(f" - {s['name']} ({s['id']}): {len(get_all_logs(session_id=s['id']))} action records")
