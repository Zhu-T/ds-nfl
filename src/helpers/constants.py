"""
Shared, env-derived configuration used across the ESPN / draft / trade /
nfl-data helpers. LLM prompt guidance itself lives in prompts/*.md (see
prompt_loader.py) so it can be tuned without touching code.
"""

import os

from src.helpers.db_manager import load_env

# Load .env here, once, before any of the os.getenv() calls below. Each helper
# used to read these individually at its own import time, which could run
# before an entry script's load_env() call — silently ignoring .env values
# unless they also happened to be real OS environment variables.
load_env()

# --- ESPN league identity & credentials ---
ESPN_LEAGUE_ID = os.getenv("ESPN_LEAGUE_ID", "12345678")
ESPN_TEAM_ID = os.getenv("ESPN_TEAM_ID", "1")
ESPN_S2 = os.getenv("ESPN_S2", "")
SWID = os.getenv("SWID", "")

# --- Local LLM (Ollama / DeepSeek) ---
OLLAMA_ENDPOINT = os.getenv("OLLAMA_ENDPOINT", "http://localhost:11434/api/generate")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "deepseek-r1:14b")
