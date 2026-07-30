"""
Dashboard Web Server & REST API
Main control center for triggering Lineup Optimizer, Live Draft Assistant, and Trade Analyzer.
"""

import sys
import os
import json
import urllib.parse
from http.server import HTTPServer, SimpleHTTPRequestHandler

# Ensure root directory is in python path
BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, BASE_DIR)

from src.helpers.db_manager import (
    load_env, get_all_logs, get_system_logs, seed_demo_data_if_empty,
    list_sessions, create_session, set_default_session,
)
from src.lineup_optimizer import run_lineup_optimizer_workflow
from src.draft_assistant import run_live_draft_assistant
from src.helpers.trade_client import run_trade_analyzer_workflow

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

        # Serve static frontend dashboard assets
        super().do_GET()

    def do_POST(self):
        parsed_path = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed_path.query)
        session_id = query.get("session", [None])[0]

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

        # Lineup Optimizer Trigger
        if parsed_path.path in ["/api/run-lineup-optimizer", "/api/run-picker"]:
            try:
                record_id = run_lineup_optimizer_workflow(session_id=session_id)
                self._send_json(200, {
                    "status": "success",
                    "message": "Lineup Optimizer executed successfully!",
                    "record_id": record_id
                })
            except Exception as e:
                self._send_json(500, {"status": "error", "message": str(e)})
            return

        # Draft Assistant Trigger
        if parsed_path.path == "/api/run-draft-assistant":
            try:
                run_live_draft_assistant(auto_click_draft=False, session_id=session_id)
                latest_logs = get_all_logs(limit=1, session_id=session_id)
                latest_id = latest_logs[0]["id"] if latest_logs else None
                self._send_json(200, {
                    "status": "success",
                    "message": "Live Draft Assistant executed successfully!",
                    "record_id": latest_id
                })
            except Exception as e:
                self._send_json(500, {"status": "error", "message": str(e)})
            return

        # Trade Analyzer Trigger
        if parsed_path.path == "/api/run-trade-analyzer":
            try:
                record_id = run_trade_analyzer_workflow(session_id=session_id)
                self._send_json(200, {
                    "status": "success",
                    "message": "Trade Analyzer executed successfully!",
                    "record_id": record_id
                })
            except Exception as e:
                self._send_json(500, {"status": "error", "message": str(e)})
            return

        self.send_error(404, "Endpoint not found")


def start_server():
    # Ensure the session registry exists, and only auto-seed the built-in
    # "test" session so newly created real sessions start empty.
    sessions = list_sessions()["sessions"]
    if any(s["id"] == "test" for s in sessions):
        seed_demo_data_if_empty(session_id="test")

    server_address = ("", PORT)
    httpd = HTTPServer(server_address, DashboardHandler)
    print(f"==================================================")
    print(f"  NFL Fantasy OpenClaw Control Dashboard")
    print(f"  URL: http://localhost:{PORT}")
    print(f"  Sessions dir: data/sessions/")
    print(f"==================================================")
    httpd.serve_forever()


if __name__ == "__main__":
    start_server()
