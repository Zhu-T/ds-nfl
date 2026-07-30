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


def fetch_cached_api_request(url: str, cookies: dict = None, ttl_seconds: int = 300, session_id: str = None) -> dict:
    """
    Checks SQLite cache for API responses.
    If valid cache entry exists within TTL, returns cached JSON data (0 HTTP requests sent, 0 IP risk).
    Otherwise, executes HTTP GET, caches response in SQLite, and returns data.
    """
    init_db(session_id)
    url_hash = hashlib.sha256(url.encode("utf-8")).hexdigest()
    now_ts = int(time.time())

    conn = get_db_connection(session_id)
    cursor = conn.cursor()
    cursor.execute("SELECT response_json, timestamp, ttl_seconds FROM api_cache WHERE url_hash = ?", (url_hash,))
    cached = cursor.fetchone()

    if cached:
        cached_ts = cached["timestamp"]
        entry_ttl = cached["ttl_seconds"]
        if (now_ts - cached_ts) < entry_ttl:
            conn.close()
            log_system_event("API_CACHE_HIT", f"Reused cached ESPN API response (0 IP requests sent): {url}", {"url": url, "age_seconds": now_ts - cached_ts}, session_id=session_id)
            return json.loads(cached["response_json"])

    # Cache Miss or Expired -> Perform fresh HTTP GET
    log_system_event("API_CACHE_MISS", f"Fetching fresh API data from ESPN: {url}", {"url": url}, session_id=session_id)
    try:
        res = requests.get(url, cookies=cookies or {}, timeout=10)
        res.raise_for_status()
        res_data = res.json()

        # Save fresh payload to SQLite API Cache
        cursor.execute("""
            INSERT OR REPLACE INTO api_cache (url_hash, url, response_json, timestamp, ttl_seconds)
            VALUES (?, ?, ?, ?, ?)
        """, (url_hash, url, json.dumps(res_data), now_ts, ttl_seconds))
        conn.commit()
        conn.close()

        log_system_event("API_CACHE_STORED", f"Cached fresh ESPN API response in SQLite (TTL: {ttl_seconds}s)", {"url": url}, session_id=session_id)
        return res_data
    except Exception as e:
        conn.close()
        log_system_event("API_FETCH_ERROR", f"Error requesting ESPN API: {e}", {"url": url, "error": str(e)}, session_id=session_id)
        raise e


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
