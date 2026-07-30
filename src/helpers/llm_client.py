import os
import json
import logging
import requests

OLLAMA_ENDPOINT = os.getenv("OLLAMA_ENDPOINT", "http://localhost:11434/api/generate")
MODEL_NAME = os.getenv("OLLAMA_MODEL", "deepseek-r1:14b")

def query_local_deepseek(prompt: str) -> dict:
    """Send prompt to local DeepSeek model running via Ollama/OpenClaw."""
    payload = {
        "model": MODEL_NAME,
        "prompt": prompt,
        "stream": False,
        "format": "json"
    }
    try:
        response = requests.post(OLLAMA_ENDPOINT, json=payload, timeout=60)
        response.raise_for_status()
        res_data = response.json()
        return json.loads(res_data.get("response", "{}"))
    except Exception as e:
        logging.error(f"Error querying DeepSeek: {e}")
        return {}
