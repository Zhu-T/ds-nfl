"""
Live / mock draft entry point.
Opens the ESPN draft room, turns Autopick off, and drafts on your turn.
"""

import sys
import os

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from src.helpers.db_manager import load_env
from src.helpers.draft_client import run_live_draft_loop

load_env()

if __name__ == "__main__":
    url = sys.argv[1] if len(sys.argv) > 1 else None
    print("==================================================")
    print("  NFL Fantasy Live Draft Assistant")
    print("==================================================")
    run_live_draft_loop(draft_url=url)
