import json
import re
import time
import logging
import requests
from src.helpers.constants import OLLAMA_ENDPOINT, OLLAMA_MODEL
from src.helpers.db_manager import log_system_event

_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)
_RESULT_KEYS = {
    "player", "recommended_player", "use_autodraft", "rb_strategy", "rationale",
    "rankings", "players", "board", "tool", "starters", "text", "name",
}


def _looks_like_result(obj) -> bool:
    if not isinstance(obj, dict) or not obj:
        return False
    keys = set(obj)
    if keys & _RESULT_KEYS:
        return True
    for nested_key in ("decision", "pick", "recommendation", "result", "data"):
        inner = obj.get(nested_key)
        if isinstance(inner, dict) and (set(inner) & _RESULT_KEYS):
            return True
        if isinstance(inner, str) and inner.strip():
            return True
    return False


def _iter_json_dicts(text: str):
    if not text or not isinstance(text, str):
        return
    decoder = json.JSONDecoder()
    i = 0
    found = 0
    n = len(text)
    while i < n and found < 24:
        start = text.find("{", i)
        if start < 0:
            return
        try:
            obj, end = decoder.raw_decode(text[start:])
        except json.JSONDecodeError:
            i = start + 1
            continue
        if isinstance(obj, dict):
            found += 1
            yield obj
        i = start + max(end, 1)


def _extract_json_object(text: str):
    """Parse a dict from model text, preferring a decision-shaped object."""
    if text is None:
        return None
    if isinstance(text, dict):
        return text
    if not isinstance(text, str):
        return None
    s = _THINK_RE.sub("\n", text).strip()
    if not s:
        return None
    s = _FENCE_RE.sub("", s).strip()
    candidates = list(_iter_json_dicts(s))
    for obj in reversed(candidates):
        if _looks_like_result(obj):
            return obj
    return None


def _parse_ollama_payload(res_data: dict):
    if not isinstance(res_data, dict):
        return {}, ""
    raw = res_data.get("response")
    if raw is None and isinstance(res_data.get("message"), dict):
        raw = res_data["message"].get("content")
    thinking = res_data.get("thinking") or ""
    if isinstance(raw, dict):
        if _looks_like_result(raw):
            return raw, json.dumps(raw, ensure_ascii=False)
        raw_text = json.dumps(raw, ensure_ascii=False)
    else:
        raw_text = raw if isinstance(raw, str) else ""
    think_text = thinking if isinstance(thinking, str) else ""
    combined = "\n".join(t for t in (think_text, raw_text) if t)
    parsed = _extract_json_object(combined)
    return parsed or {}, combined


def query_local_deepseek(prompt: str, session_id: str = None, timeout: int = 60) -> dict:
    """Send prompt to local DeepSeek model running via Ollama/OpenClaw."""
    payload = {
        "model": OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False,
    }
    started = time.time()
    try:
        response = requests.post(OLLAMA_ENDPOINT, json=payload, timeout=timeout)
        response.raise_for_status()
        res_data = response.json()
        elapsed = time.time() - started
        parsed, raw_text = _parse_ollama_payload(res_data)
        if not _looks_like_result(parsed):
            snippet = (raw_text or "").replace("\n", " ")[:300]
            logging.warning(
                f"DeepSeek ({OLLAMA_MODEL}) did not return a usable JSON decision after {elapsed:.1f}s"
                + (f": {snippet}" if snippet else "")
            )
            parsed = {}
        msg = f"DeepSeek ({OLLAMA_MODEL}) responded in {elapsed:.1f}s"
        logging.info(msg)
        log_system_event(
            "LLM_CALL_SUCCESS",
            msg,
            {
                "model": OLLAMA_MODEL,
                "elapsed_seconds": round(elapsed, 2),
                "parsed_keys": [str(k)[:80] for k in list(parsed)[:12]],
            },
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
