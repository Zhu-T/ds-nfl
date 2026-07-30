import json
import time
import logging
import requests
from src.helpers.constants import OLLAMA_ENDPOINT, OLLAMA_MODEL
from src.helpers.db_manager import log_system_event

def query_local_deepseek(prompt: str, session_id: str = None) -> dict:
    """Send prompt to local DeepSeek model running via Ollama/OpenClaw."""
    payload = {
        "model": OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False,
        "format": "json"
    }
    started = time.time()
    try:
        response = requests.post(OLLAMA_ENDPOINT, json=payload, timeout=60)
        response.raise_for_status()
        res_data = response.json()
        elapsed = time.time() - started
        parsed = json.loads(res_data.get("response", "{}"))
        log_system_event(
            "LLM_CALL_SUCCESS",
            f"DeepSeek ({OLLAMA_MODEL}) responded in {elapsed:.1f}s",
            {"model": OLLAMA_MODEL, "elapsed_seconds": round(elapsed, 2), "prompt_chars": len(prompt)},
            session_id=session_id
        )
        return parsed
    except Exception as e:
        elapsed = time.time() - started
        logging.error(f"Error querying DeepSeek: {e}")
        log_system_event(
            "LLM_CALL_ERROR",
            f"DeepSeek ({OLLAMA_MODEL}) call failed after {elapsed:.1f}s: {e}",
            {"model": OLLAMA_MODEL, "elapsed_seconds": round(elapsed, 2), "error": str(e)},
            session_id=session_id
        )
        return {}
