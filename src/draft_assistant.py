"""
Draft Assistant Entry Point
Runs DeepSeek Live Draft Recommendation & ESPN Draft Room Auto-Picker
"""

import sys
import os

# Add root directory to python path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from src.helpers.db_manager import load_env
from src.helpers.draft_client import run_live_draft_assistant

load_env()

if __name__ == "__main__":
    print("==================================================")
    print("  NFL Fantasy OpenClaw Live Draft Assistant")
    print("  Powered by Local DeepSeek R1")
    print("==================================================")
    
    # Run draft assistant (set auto_click_draft=True to automatically click Draft in ESPN UI)
    # Uses the default session (see dashboard "Sessions" switcher / db_manager.set_default_session)
    run_live_draft_assistant(auto_click_draft=False)
