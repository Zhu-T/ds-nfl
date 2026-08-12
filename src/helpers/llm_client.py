import json
import re
import time
import logging
import requests
from src.helpers.constants import OLLAMA_ENDPOINT, OLLAMA_MODEL
from src.helpers.db_manager import log_system_event

_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)


def _extract_json_object(text: str):
    """Parse a dict from model text (think tags, fences, or embedded JSON)."""
    if text is None:
        return None
    if isinstance(text, dict):
        return text
    if not isinstance(text, str):
        return None
    s = _THINK_RE.sub("", text).strip()
    if not s:
        return None
    s = _FENCE_RE.sub("", s).strip()
    candidates = [s]
    start = s.find("{")
    end = s.rfind("}")
    if start >= 0 and end > start:
        candidates.append(s[start:end + 1])
    for blob in candidates:
        try:
            obj = json.loads(blob)
        except Exception:
            obj = None
            if blob.startswith("{"):
                try:
                    obj, _ = json.JSONDecoder().raw_decode(blob)
                except Exception:
                    obj = None
        if isinstance(obj, dict):
            return obj
        if isinstance(obj, str):
            nested = _extract_json_object(obj)
            if nested:
                return nested
    return None


def _parse_ollama_payload(res_data: dict):
    if not isinstance(res_data, dict):
        return {}, ""
    raw = res_data.get("response")
    if raw is None and isinstance(res_data.get("message"), dict):
        raw = res_data["message"].get("content")
    thinking = res_data.get("thinking") or ""
    if isinstance(raw, dict):
        return raw, json.dumps(raw, ensure_ascii=False)
    text = raw if isinstance(raw, str) else ""
    parsed = _extract_json_object(text)
    if not parsed and thinking:
        parsed = _extract_json_object(thinking if isinstance(thinking, str) else "")
    raw_text = text or (thinking if isinstance(thinking, str) else "")
    return parsed or {}, raw_text


def query_local_deepseek(prompt: str, session_id: str = None, timeout: int = 60) -> dict:
    """Send prompt to local DeepSeek model running via Ollama/OpenClaw."""
    payload = {
        "model": OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False,
        "format": "json"
    }
    started = time.time()
    try:
        response = requests.post(OLLAMA_ENDPOINT, json=payload, timeout=timeout)
        response.raise_for_status()
        res_data = response.json()
        elapsed = time.time() - started
        parsed, raw_text = _parse_ollama_payload(res_data)
        if not parsed:
            snippet = (raw_text or "")[:400]
            logging.warning(
                f"DeepSeek ({OLLAMA_MODEL}) returned non-JSON or empty object after {elapsed:.1f}s"
                + (f": {snippet}" if snippet else "")
            )
        msg = f"DeepSeek ({OLLAMA_MODEL}) responded in {elapsed:.1f}s"
        logging.info(msg)
        log_system_event(
            "LLM_CALL_SUCCESS",
            msg,
            {"model": OLLAMA_MODEL, "elapsed_seconds": round(elapsed, 2), "parsed_keys": list(parsed)[:12]},
            session_id=session_id
        )
        return parsed
    except Exception as e:
        elapsed = time.time() - started
        msg = f"DeepSeek ({OLLAMA_MODEL}) call failed after {elapsed:.1f}s: {e}"
        logging.error(msg)
        log_system_event(
            "LLM_CALL_ERROR",
            msg,
            {"model": OLLAMA_MODEL, "elapsed_seconds": round(elapsed, 2), "error": str(e)},
            session_id=session_id
        )
        return {}
