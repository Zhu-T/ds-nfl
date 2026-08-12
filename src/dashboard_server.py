"""
Dashboard Web Server & REST API
Main control center for triggering Lineup Optimizer, Pre-Draft Strategy, Live Draft, and Trade Analyzer.
"""

import sys
import os
import json
import logging
import urllib.parse
from http.server import HTTPServer, SimpleHTTPRequestHandler

# Ensure root directory is in python path
BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, BASE_DIR)

from src.helpers.db_manager import (
    load_env, get_all_logs, get_system_logs, seed_demo_data_if_empty,
    list_sessions, create_session, set_default_session, delete_session,
    get_suggestions_for_action, update_suggestion_status, get_league_settings,
    get_espn_settings, save_espn_settings,
)
from src.lineup_optimizer import run_lineup_optimizer_workflow, apply_accepted_lineup_suggestions
from src.helpers.draft_strategy_client import setup_draft_strategy
from src.helpers.draft_client import start_live_draft, stop_live_draft, live_draft_status
from src.helpers.trade_client import run_trade_analyzer_workflow, apply_trade_suggestions
from src.helpers.chat_client import ask_deepseek, get_chat_history

# Maps an action_log's action_type prefix to the function that executes its
# accepted suggestions (dispatched from /api/suggestions/execute).
def _executor_for_action_type(action_type: str):
    if action_type == "LINEUP_OPTIMIZATION":
        return apply_accepted_lineup_suggestions
    if action_type.startswith("TRADE_OFFER"):
        return apply_trade_suggestions
    return None

load_env()
PORT = int(os.getenv("DASHBOARD_PORT", 8000))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")


class DashboardHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC_DIR, **kwargs)

    def _send_json(self, status: int, payload):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode("utf-8"))

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except Exception:
            return {}

    def do_GET(self):
        parsed_path = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed_path.query)
        session_id = query.get("session", [None])[0]

        # Session Registry API
        if parsed_path.path == "/api/sessions":
            self._send_json(200, list_sessions())
            return

        # Action History API
        if parsed_path.path == "/api/history":
            self._send_json(200, get_all_logs(session_id=session_id))
            return

        # System & Cache Logs API
        if parsed_path.path == "/api/system-logs":
            self._send_json(200, get_system_logs(session_id=session_id))
            return

        # Suggestions for a single action run (?action_id=N)
        if parsed_path.path == "/api/suggestions":
            action_id = query.get("action_id", [None])[0]
            if not action_id:
                self._send_json(400, {"status": "error", "message": "action_id is required"})
                return
            self._send_json(200, get_suggestions_for_action(int(action_id), session_id=session_id))
            return

        # League/roster/draft settings saved for this session (null until
        # Setup Draft Strategy has run there at least once)
        if parsed_path.path == "/api/league-settings":
            self._send_json(200, get_league_settings(session_id=session_id))
            return

        # Chat history for this session
        if parsed_path.path == "/api/chat":
            self._send_json(200, get_chat_history(session_id=session_id))
            return

        # Live/mock draft job status (picks always execute in-room).
        if parsed_path.path == "/api/live-draft-status":
            self._send_json(200, live_draft_status(session_id=session_id))
            return

        # This session's ESPN connection settings. Cookie values themselves are
        # never sent back to the browser once saved — only whether they're set —
        # since there's no reason to redisplay a login session token.
        if parsed_path.path == "/api/espn-settings":
            saved = get_espn_settings(session_id=session_id) or {}
            self._send_json(200, {
                "league_id": saved.get("league_id"),
                "team_id": saved.get("team_id"),
                "espn_s2_set": bool(saved.get("espn_s2")),
                "swid_set": bool(saved.get("swid")),
            })
            return

        # Serve static frontend dashboard assets
        super().do_GET()

    def do_POST(self):
        parsed_path = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed_path.query)
        session_id = query.get("session", [None])[0]
        auto_execute = query.get("auto", ["false"])[0].lower() == "true"

        # Accept or decline a single suggestion
        if parsed_path.path == "/api/suggestions/decide":
            try:
                body = self._read_json_body()
                suggestion_id = int(body.get("suggestion_id"))
                decision = body.get("decision", "").upper()
                if decision not in ("ACCEPTED", "DECLINED"):
                    raise ValueError("decision must be ACCEPTED or DECLINED")
                suggestion = update_suggestion_status(suggestion_id, decision, session_id=session_id)
                self._send_json(200, {"status": "success", "suggestion": suggestion})
            except Exception as e:
                self._send_json(400, {"status": "error", "message": str(e)})
            return

        # Execute the accepted suggestions for one action run
        if parsed_path.path == "/api/suggestions/execute":
            try:
                body = self._read_json_body()
                action_log_id = int(body.get("action_log_id"))
                action_type = body.get("action_type", "")
                executor = _executor_for_action_type(action_type)
                if not executor:
                    raise ValueError(f"No executor for action_type: {action_type}")
                result = executor(action_log_id, session_id=session_id)
                self._send_json(200, {"status": "success", **result})
            except Exception as e:
                self._send_json(500, {"status": "error", "message": str(e)})
            return

        # Ask DeepSeek a free-form question
        if parsed_path.path == "/api/chat":
            try:
                body = self._read_json_body()
                question = (body.get("question") or "").strip()
                if not question:
                    raise ValueError("question is required")
                result = ask_deepseek(question, session_id=session_id)
                self._send_json(200, {"status": "success", **result})
            except Exception as e:
                self._send_json(500, {"status": "error", "message": str(e)})
            return

        # Save this session's ESPN connection settings. Blank fields are left
        # untouched (see save_espn_settings) so submitting just a league id
        # doesn't wipe out cookies harvested separately, and vice versa.
        if parsed_path.path == "/api/espn-settings":
            try:
                body = self._read_json_body()
                league_id = (body.get("league_id") or "").strip() or None
                team_id = (body.get("team_id") or "").strip() or None
                espn_s2 = (body.get("espn_s2") or "").strip() or None
                swid = (body.get("swid") or "").strip() or None
                result = save_espn_settings(league_id=league_id, team_id=team_id, espn_s2=espn_s2, swid=swid, session_id=session_id)
                self._send_json(200, {
                    "status": "success",
                    "league_id": result["league_id"],
                    "team_id": result["team_id"],
                    "espn_s2_set": bool(result["espn_s2"]),
                    "swid_set": bool(result["swid"]),
                })
            except Exception as e:
                self._send_json(400, {"status": "error", "message": str(e)})
            return

        # Create a new session
        if parsed_path.path == "/api/sessions":
            try:
                body = self._read_json_body()
                session = create_session(body.get("name", ""))
                self._send_json(200, {"status": "success", "session": session})
            except Exception as e:
                self._send_json(400, {"status": "error", "message": str(e)})
            return

        # Set the default session
        if parsed_path.path == "/api/sessions/default":
            try:
                body = self._read_json_body()
                result = set_default_session(body.get("session_id", ""))
                self._send_json(200, {"status": "success", **result})
            except Exception as e:
                self._send_json(400, {"status": "error", "message": str(e)})
            return

        # Delete a session (and its db file)
        if parsed_path.path == "/api/sessions/delete":
            try:
                body = self._read_json_body()
                result = delete_session(body.get("session_id", ""))
                self._send_json(200, {"status": "success", **result})
            except Exception as e:
                self._send_json(400, {"status": "error", "message": str(e)})
            return

        # Lineup Optimizer Trigger
        if parsed_path.path in ["/api/run-lineup-optimizer", "/api/run-picker"]:
            try:
                record_id = run_lineup_optimizer_workflow(session_id=session_id, auto_execute=auto_execute)
                self._send_json(200, {
                    "status": "success",
                    "message": "Lineup set automatically." if auto_execute else "Lineup suggestions ready for review.",
                    "record_id": record_id
                })
            except Exception as e:
                self._send_json(500, {"status": "error", "message": str(e)})
            return

        # Pre-Draft Strategy: DeepSeek ranks top N players → ESPN draftList
        if parsed_path.path == "/api/run-draft-strategy":
            try:
                body = self._read_json_body()
                league_id = (
                    (query.get("league_id", [None])[0] or "").strip()
                    or (body.get("league_id") or "").strip()
                    or None
                )
                team_id = (
                    (query.get("team_id", [None])[0] or "").strip()
                    or (body.get("team_id") or "").strip()
                    or None
                )
                top_n_raw = (
                    (query.get("top_n", [None])[0] or "")
                    or body.get("top_n")
                    or 100
                )
                try:
                    top_n = max(1, min(300, int(top_n_raw)))
                except (TypeError, ValueError):
                    top_n = 100
                result = setup_draft_strategy(
                    league_id=league_id,
                    team_id=team_id,
                    top_n=top_n,
                    session_id=session_id,
                )
                self._send_json(200, {
                    "status": "success",
                    "message": (
                        f"Saved DeepSeek's top {result['wrote_count']} rankings"
                        + (
                            f" and {len(result.get('pick_by_pick') or [])} pick-by-pick prefs"
                            if result.get("pick_by_pick") else ""
                        )
                        + " to ESPN pre-draft strategy."
                    ),
                    **result,
                })
            except Exception as e:
                self._send_json(500, {"status": "error", "message": str(e)})
            return

        # Live / mock draft: always automatic (Suggest/Auto does not apply).
        if parsed_path.path == "/api/run-live-draft":
            try:
                body = self._read_json_body()
                draft_url = (
                    (query.get("draft_url", [None])[0] or "").strip()
                    or (body.get("draft_url") or "").strip()
                    or None
                )
                status = start_live_draft(draft_url=draft_url, session_id=session_id)
                self._send_json(200, {
                    "status": "success",
                    "message": "Live draft started. Picks will be made automatically on your turn.",
                    **status,
                })
            except Exception as e:
                self._send_json(500, {"status": "error", "message": str(e)})
            return

        if parsed_path.path == "/api/stop-live-draft":
            try:
                status = stop_live_draft(session_id=session_id)
                self._send_json(200, {
                    "status": "success",
                    "message": "Stopping live draft…",
                    **status,
                })
            except Exception as e:
                self._send_json(500, {"status": "error", "message": str(e)})
            return

        # Trade Analyzer Trigger
        if parsed_path.path == "/api/run-trade-analyzer":
            try:
                record_id = run_trade_analyzer_workflow(session_id=session_id, auto_execute=auto_execute)
                self._send_json(200, {
                    "status": "success",
                    "message": "Trade review recorded automatically." if auto_execute else "Trade suggestions ready for review.",
                    "record_id": record_id
                })
            except Exception as e:
                self._send_json(500, {"status": "error", "message": str(e)})
            return

        self._send_json(404, {"status": "error", "message": f"Endpoint not found: {parsed_path.path}"})


def _configure_logging():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(levelname)s - %(message)s",
        stream=sys.stdout,
        force=True,
    )


def start_server():
    _configure_logging()
    # Ensure the session registry exists, and only auto-seed the built-in
    # "test" session so newly created real sessions start empty.
    sessions = list_sessions()["sessions"]
    if any(s["id"] == "test" for s in sessions):
        seed_demo_data_if_empty(session_id="test")

    server_address = ("", PORT)
    try:
        httpd = HTTPServer(server_address, DashboardHandler)
    except OSError as e:
        print(f"ERROR: Port {PORT} is already in use.", flush=True)
        print("Close the other dashboard process so this console can show logs.", flush=True)
        print(f"  ({e})", flush=True)
        try:
            input("Press Enter to exit...")
        except EOFError:
            pass
        sys.exit(1)

    print("==================================================", flush=True)
    print("  NFL Fantasy OpenClaw Control Dashboard", flush=True)
    print(f"  URL: http://localhost:{PORT}", flush=True)
    print("  Sessions dir: data/sessions/", flush=True)
    print("==================================================", flush=True)
    logging.info("Dashboard listening on http://localhost:%s", PORT)
    httpd.serve_forever()


if __name__ == "__main__":
    start_server()
