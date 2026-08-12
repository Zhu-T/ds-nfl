"""
ESPN live / mock draft helper.

On your turn: scrape taken players (right), current roster (left), and the
Autodraft suggestion (banner). DeepSeek names one pick. If it is the
Autodraft suggestion, click DRAFT on the banner; otherwise search the
available-players table. If that player cannot be found, click the banner.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from typing import Optional

from playwright.sync_api import sync_playwright

from src.helpers.db_manager import get_league_settings, log_action, log_system_event
from src.helpers.espn_client import (
    draft_slot_band,
    ensure_espn_login,
    espn_season,
    fetch_draft_picks_detail,
    fetch_espn_league_settings,
    format_draft_order_block,
    format_league_settings_block,
    get_saved_league_settings_block,
    remember_espn_player,
    resolve_espn_settings,
    snake_picks_until_next,
)
from src.helpers.llm_client import query_local_deepseek
from src.helpers.playwright_runner import playwright_sync
from src.helpers.prompt_loader import load_guidance

_JOBS: dict = {}
_JOBS_LOCK = threading.Lock()

_SCRAPE_JS = """() => {
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const posOf = (s) => {
    const m = (s || "").match(/\\b(QB|RB|WR|TE|K|D\\/ST|DST|DEF|FLEX|OP|BE)\\b/i);
    if (!m) return "";
    const p = m[1].toUpperCase();
    if (p === "DEF" || p === "DST") return "D/ST";
    if (p === "BE") return "";
    return p;
  };

  const body = (document.body && document.body.innerText) || "";
  const draftComplete = /draft is complete|draft complete|view results/i.test(body);

  const autopickOn = (() => {
    const input = document.querySelector(".autoPick-container input.form__control--toggle, .autoPick-toggle input");
    if (input && (input.checked || input.getAttribute("aria-checked") === "true")) return true;
    const indicator = document.querySelector(".autoPick-container .control__indicator");
    if (indicator) {
      const bg = getComputedStyle(indicator).backgroundColor || "";
      const m = bg.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
      if (m && (+m[2] > +m[1] + 15) && +m[2] > 90) return true;
    }
    return [...document.querySelectorAll(".own-pick")].some((el) =>
      el.querySelector(".auto-word") || /\\bAUTO\\b/.test(el.innerText || "") || el.querySelector(".autopick")
    );
  })();

  const pickArea = document.querySelector(".pickArea");
  const pickAreaText = norm(pickArea && pickArea.innerText);
  const bannerDraft = pickArea && pickArea.querySelector("button.Button--draft");
  const myTurn = !!(bannerDraft && /you are on the clock/i.test(pickAreaText) && !/on the clock in/i.test(pickAreaText));

  let suggestion = null;
  const sugMatch = pickAreaText.match(/your autopick would be:\\s*(.+?)\\s*\\/\\s*(.+?)\\s+(QB|RB|WR|TE|K|D\\/ST|DST)\\b/i);
  if (sugMatch) {
    suggestion = { name: norm(sugMatch[1]), pos: posOf(sugMatch[3]) };
  }

  const myTeam = [];
  const seenTeam = new Set();
  for (const row of document.querySelectorAll(".roster .Table__TR, .roster tr")) {
    const col = row.querySelector(".player-column");
    const name = norm((col && col.getAttribute("title")) || "");
    if (!name || /empty/i.test((col && col.innerText) || "")) continue;
    const key = name.toLowerCase();
    if (seenTeam.has(key)) continue;
    seenTeam.add(key);
    myTeam.push({ name, pos: posOf(row.innerText) });
  }

  const cols = [...document.querySelectorAll(".draft-columns > .draft-column")];
  const right = cols.length ? cols[cols.length - 1] : document.querySelector(".draft-column.flex");
  const picked = [];
  const seenPick = new Set();
  const pickNodes = right
    ? right.querySelectorAll(".pick-message__container, .playerinfo__playername")
    : [];
  for (const el of pickNodes) {
    const nameEl = el.classList && el.classList.contains("playerinfo__playername")
      ? el
      : el.querySelector(".playerinfo__playername");
    const name = norm(nameEl && nameEl.innerText);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seenPick.has(key)) continue;
    seenPick.add(key);
    const posEl = (el.closest(".pick-message__container") || el.parentElement || el).querySelector(".playerinfo__playerpos");
    picked.push({ name, pos: posOf((posEl && posEl.innerText) || el.innerText) });
  }

  return {
    my_turn: myTurn,
    autopick_on: autopickOn,
    autodraft_suggestion: suggestion,
    my_team: myTeam,
    picked: picked,
    draft_complete: draftComplete,
  };
}"""


def _norm_name(name: str) -> str:
    s = re.sub(r"[^a-z0-9 ]", "", (name or "").lower())
    s = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", "", s)
    return re.sub(r"\s+", " ", s).strip()


def _names_match(a: str, b: str) -> bool:
    na, nb = _norm_name(a), _norm_name(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    return na in nb or nb in na


def _live_draft_url(draft_url: str = None, session_id: str = None) -> str:
    raw = (draft_url or "").strip()
    if raw:
        return raw
    settings = resolve_espn_settings(session_id=session_id)
    league_id = settings.get("league_id") or ""
    team_id = settings.get("team_id") or ""
    season = espn_season()
    url = f"https://fantasy.espn.com/football/draft?leagueId={league_id}&seasonId={season}"
    if team_id:
        url += f"&teamId={team_id}"
    return url


def _league_block(session_id: str = None) -> str:
    try:
        settings = fetch_espn_league_settings(session_id=session_id, ttl_seconds=60)
        block = "\n\n".join(filter(None, [
            format_league_settings_block(settings),
            format_draft_order_block(
                settings.get("draft_order") or [],
                settings.get("draft_type") or "SNAKE",
            ),
        ]))
        if block.strip():
            return block
    except Exception as e:
        logging.warning(f"Could not refresh league settings for live draft: {e}")
    return get_saved_league_settings_block(session_id=session_id)


def _is_page_not_found(page) -> bool:
    try:
        title = (page.title() or "").lower()
        if "not found" in title:
            return True
        return page.get_by_text("Page Not Found", exact=False).first.is_visible(timeout=800)
    except Exception:
        return False


def _scrape(page) -> dict:
    try:
        data = page.evaluate(_SCRAPE_JS)
    except Exception as e:
        logging.warning(f"Draft scrape failed: {e}")
        data = {}
    return {
        "my_turn": bool(data.get("my_turn")),
        "autopick_on": bool(data.get("autopick_on")),
        "autodraft_suggestion": data.get("autodraft_suggestion"),
        "my_team": list(data.get("my_team") or []),
        "picked": list(data.get("picked") or []),
        "draft_complete": bool(data.get("draft_complete")),
    }


def _autopick_input(page):
    return page.locator(".autoPick-container input.form__control--toggle, .autoPick-toggle input").first


_AUTOPICK_STATE_JS = """() => {
  const input = document.querySelector(".autoPick-container input.form__control--toggle, .autoPick-toggle input");
  const checked = !!(input && (input.checked || input.getAttribute("aria-checked") === "true"));
  let visualOn = false;
  const indicator = document.querySelector(".autoPick-container .control__indicator");
  if (indicator) {
    const bg = getComputedStyle(indicator).backgroundColor || "";
    const m = bg.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
    if (m) visualOn = (+m[2] > +m[1] + 15) && +m[2] > 90;
  }
  const ownAuto = [...document.querySelectorAll(".own-pick")].some((el) =>
    el.querySelector(".auto-word")
    || el.querySelector(".autopick")
    || /\\bAUTO\\b/.test(el.innerText || "")
  );
  return { on: checked || visualOn || ownAuto, checked, visualOn, ownAuto, found: !!input };
}"""


def _autopick_state(page) -> dict:
    try:
        data = page.evaluate(_AUTOPICK_STATE_JS) or {}
    except Exception:
        data = {}
    return {
        "on": bool(data.get("on")),
        "checked": bool(data.get("checked")),
        "visualOn": bool(data.get("visualOn")),
        "ownAuto": bool(data.get("ownAuto")),
        "found": bool(data.get("found")),
    }


def _autopick_is_on(page) -> bool:
    return bool(_autopick_state(page).get("on"))


def _disable_autopick(page) -> bool:
    """If Autopick is on right now, click it off. Returns True when a click was attempted."""
    if not _autopick_is_on(page):
        return False
    targets = [
        page.locator(".autoPick-container .control__indicator").first,
        page.locator(".autoPick-toggle .control__indicator").first,
        page.locator(".autoPick-container label.form__toggle").first,
        page.locator(".autoPick-label").first,
        _autopick_input(page),
    ]
    for loc in targets:
        try:
            if not loc.count():
                continue
            loc.click(timeout=1500, force=True)
            page.wait_for_timeout(300)
            if not _autopick_is_on(page):
                return True
        except Exception:
            continue
    try:
        page.evaluate(
            """() => {
              const input = document.querySelector(".autoPick-container input.form__control--toggle, .autoPick-toggle input");
              if (!input) return;
              const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "checked");
              if (desc && desc.set) desc.set.call(input, false);
              else input.checked = false;
              for (const type of ["click", "input", "change"]) {
                input.dispatchEvent(new Event(type, { bubbles: true }));
              }
            }"""
        )
        page.wait_for_timeout(250)
    except Exception as e:
        logging.warning(f"Could not toggle Autopick off: {e}")
    return True


def _ensure_autopick_off(page, attempts: int = 6) -> bool:
    """Re-read Autopick every attempt and click until it is actually off."""
    try:
        page.locator(".autoPick-container, .autoPick-toggle").first.wait_for(state="visible", timeout=8000)
    except Exception:
        return not _autopick_is_on(page)
    for _ in range(max(1, attempts)):
        if not _autopick_is_on(page):
            return True
        _disable_autopick(page)
        page.wait_for_timeout(300)
    still_on = _autopick_is_on(page)
    if still_on:
        logging.warning("Autopick is still on after retries.")
    return not still_on


def _click_banner_draft(page) -> bool:
    try:
        return bool(page.evaluate(
            """() => {
              const btn = document.querySelector(".pickArea button.Button--draft, .on-the-clock button.Button--draft");
              if (btn) { btn.click(); return true; }
              return false;
            }"""
        ))
    except Exception as e:
        logging.warning(f"Banner DRAFT click failed: {e}")
        return False


_NAME_MATCH_JS = """(a, b) => {
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\\s+/g, " ").trim();
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = na.split(" ").filter(Boolean);
  const tb = nb.split(" ").filter(Boolean);
  if (ta.length >= 2 && tb.length >= 2 && ta[0] === tb[0] && ta[ta.length - 1] === tb[tb.length - 1]) return true;
  return false;
}"""

_SEARCH_MATCH_JS = """(name) => {
  const namesMatch = """ + _NAME_MATCH_JS + """;
  const btns = [...document.querySelectorAll("button.player--search--match")];
  const match = btns.find((b) => {
    const t = ((b.querySelector(".playerinfo__playername") || b).innerText || "");
    return namesMatch(name, t);
  });
  if (!match) return false;
  match.click();
  return true;
}"""

_TABLE_ROW_DRAFT_JS = """(name) => {
  const namesMatch = """ + _NAME_MATCH_JS + """;
  const isDraft = (b) => {
    const text = (b.innerText || "").replace(/\\s+/g, " ").trim();
    if (!/^DRAFT$/i.test(text)) return false;
    if (b.disabled || b.classList.contains("Button--drafted") || b.classList.contains("Button--disabled")) return false;
    return true;
  };
  const nameEls = [...document.querySelectorAll(
    ".draft-players .public_fixedDataTable_bodyRow .playerinfo__playername, .draft-players .fixedDataTableRowLayout_main .playerinfo__playername"
  )].filter((el) => !el.closest(".player--search--matches, button.player--search--match"));
  const matchEl = nameEls.find((el) => namesMatch(name, el.innerText || ""));
  if (!matchEl) return false;
  const row = matchEl.closest(".public_fixedDataTable_bodyRow, .fixedDataTableRowLayout_main, .fixedDataTableRowLayout_rowWrapper");
  const rowBtn = row && [...row.querySelectorAll("button.action-btn, button.Button--draft")].find(isDraft);
  if (rowBtn) { rowBtn.click(); return "row"; }
  const y = matchEl.getBoundingClientRect().top;
  const aligned = [...document.querySelectorAll(".draft-players button.action-btn, .draft-players button.Button--draft")]
    .filter((b) => !b.closest(".pickArea, .player--search--matches") && isDraft(b))
    .find((b) => Math.abs(b.getBoundingClientRect().top - y) < 22);
  if (aligned) { aligned.click(); return "aligned"; }
  return false;
}"""


def _search_and_select_player(page, player_name: str) -> bool:
    """Type in Player Name and click the matching search dropdown result."""
    box = page.locator(
        '.playersSearch input[placeholder="Player Name"], input[placeholder="Player Name"]'
    )
    if not box.count():
        return False
    field = box.first
    field.click(timeout=2000)
    field.fill("")
    page.wait_for_timeout(80)
    field.press_sequentially(player_name, delay=35)
    try:
        page.locator("button.player--search--match").first.wait_for(state="visible", timeout=2500)
    except Exception:
        return False
    return bool(page.evaluate(_SEARCH_MATCH_JS, player_name))


def _click_table_row_draft(page, player_name: str) -> bool:
    """Click DRAFT only on the table row whose name matches player_name."""
    return bool(page.evaluate(_TABLE_ROW_DRAFT_JS, player_name))


def _click_table_draft(page, player_name: str) -> bool:
    try:
        selected = _search_and_select_player(page, player_name)
        page.wait_for_timeout(700 if selected else 200)
        if _click_table_row_draft(page, player_name):
            return True
        logging.warning(
            f"No name-matched table DRAFT button for {player_name}"
            + ("" if selected else " (search match also failed)")
        )
        return False
    except Exception as e:
        logging.warning(f"Table DRAFT click failed for {player_name}: {e}")
        return False


_SKILL_POS = ("QB", "RB", "WR", "TE", "K", "D/ST")
_RB_STRATEGIES = ("Hero RB", "Robust RB", "Zero RB", "Hyper-Fragile RB")
_PICK_DEADLINE_SECONDS = 30


def _merge_taken(scraped: list, session_id: str = None) -> list:
    """
    Taken board keyed by ESPN playerId. mDraftDetail is the source of truth;
    IDs already seen this live-draft run are kept even if a later fetch is
    incomplete. Names/positions are resolved and cached for the session.
    """
    sid = session_id or ""
    try:
        detail = fetch_draft_picks_detail(session_id=session_id, ttl_seconds=0)
    except Exception:
        detail = []

    with _JOBS_LOCK:
        job = _JOBS.get(sid) or {}
        by_id = dict(job.get("taken_by_id") or {})

    scraped_items = []
    for item in scraped or []:
        if not isinstance(item, dict):
            continue
        name = (item.get("name") or "").strip()
        if not name:
            continue
        scraped_items.append({"name": name, "pos": _norm_pos(item.get("pos") or "")})

    for pick in detail or []:
        pid = pick.get("player_id")
        if not pid:
            continue
        try:
            key = str(int(pid))
        except (TypeError, ValueError):
            continue
        prev = by_id.get(key) or {}
        name = (pick.get("name") or "").strip() or prev.get("name") or ""
        pos = _norm_pos(pick.get("pos") or prev.get("pos") or "")
        by_id[key] = {
            "player_id": int(pid),
            "name": name,
            "pos": pos,
            "overall": pick.get("overall") or prev.get("overall") or 0,
            "team_id": pick.get("team_id") if pick.get("team_id") is not None else prev.get("team_id") or 0,
        }

    used_scrape = set()
    for rec in by_id.values():
        rec_name = (rec.get("name") or "").strip()
        if not rec_name:
            continue
        for i, s in enumerate(scraped_items):
            if i in used_scrape:
                continue
            if _names_match(rec_name, s["name"]):
                if s.get("pos") and not rec.get("pos"):
                    rec["pos"] = s["pos"]
                used_scrape.add(i)
                break

    unnamed = sorted(
        [rec for rec in by_id.values() if not (rec.get("name") or "").strip()],
        key=lambda r: r.get("overall") or 0,
        reverse=True,
    )
    leftover_idxs = [i for i, _s in enumerate(scraped_items) if i not in used_scrape]
    for rec, idx in zip(unnamed, leftover_idxs):
        s = scraped_items[idx]
        rec["name"] = s["name"]
        rec["pos"] = rec.get("pos") or s.get("pos") or ""
        used_scrape.add(idx)

    for rec in by_id.values():
        if rec.get("name"):
            remember_espn_player(session_id, rec["player_id"], rec["name"], rec.get("pos") or "")

    with _JOBS_LOCK:
        job = _JOBS.get(sid)
        if job is not None:
            job["taken_by_id"] = by_id

    out = []
    seen_names = set()
    for rec in sorted(by_id.values(), key=lambda r: r.get("overall") or 0):
        name = (rec.get("name") or "").strip()
        if not name:
            continue
        key = _norm_name(name)
        if not key or key in seen_names:
            continue
        seen_names.add(key)
        out.append({"name": name, "pos": rec.get("pos") or ""})
    for i, s in enumerate(scraped_items):
        if i in used_scrape:
            continue
        key = _norm_name(s["name"])
        if not key or key in seen_names:
            continue
        seen_names.add(key)
        out.append({"name": s["name"], "pos": s.get("pos") or ""})
    return out


def _norm_pos(pos: str) -> str:
    p = (pos or "").upper().strip()
    if p in ("DST", "DEF", "D/ST"):
        return "D/ST"
    return p


def _count_by_pos(players: list) -> dict:
    counts = {k: 0 for k in _SKILL_POS}
    for item in players or []:
        if not isinstance(item, dict):
            continue
        pos = _norm_pos(item.get("pos"))
        if pos in counts:
            counts[pos] += 1
    return counts


def _parse_starter_needs(roster_settings: str) -> dict:
    needs = {k: 0 for k in _SKILL_POS}
    needs["FLEX"] = 0
    needs["OP"] = 0
    needs["BENCH"] = 0
    for match in re.finditer(
        r"(\d+)\s+(QB|RB|WR|TE|FLEX|OP|K|D/ST|DST|DEF|BENCH)\b",
        roster_settings or "",
        re.I,
    ):
        pos = _norm_pos(match.group(2))
        needs[pos] = needs.get(pos, 0) + int(match.group(1))
    return needs


def _roster_holes(my_counts: dict, needs: dict) -> dict:
    holes = {}
    extras = {}
    for pos in _SKILL_POS:
        have = int(my_counts.get(pos) or 0)
        need = int(needs.get(pos) or 0)
        holes[pos] = max(0, need - have)
        extras[pos] = max(0, have - need)
    flex_need = int(needs.get("FLEX") or 0) + int(needs.get("OP") or 0)
    flex_fill = extras.get("RB", 0) + extras.get("WR", 0) + extras.get("TE", 0)
    holes["FLEX"] = max(0, flex_need - flex_fill)
    return holes


def _board_snapshot(picked: list, my_team: list, session_id: str = None) -> dict:
    taken = _count_by_pos(picked)
    roster = _count_by_pos(my_team)
    recent = list(reversed(picked or []))[:10]
    saved = get_league_settings(session_id=session_id) or {}
    needs = _parse_starter_needs(saved.get("roster_settings") or "")
    draft_order = list(saved.get("draft_order_json") or [])
    draft_type = saved.get("draft_type") or "SNAKE"
    team_count = len(draft_order)
    your_slot = next((p.get("pick") for p in draft_order if p.get("is_you")), None)
    taken_total = sum(taken.values())
    current_overall = taken_total + 1
    wait = snake_picks_until_next(your_slot, team_count, current_overall, draft_type) if your_slot and team_count else None
    turn_teams = []
    if team_count:
        with _JOBS_LOCK:
            cached_picks = list(((_JOBS.get(session_id or "") or {}).get("taken_by_id") or {}).values())
        detail = cached_picks
        if not detail:
            try:
                detail = fetch_draft_picks_detail(session_id=session_id, ttl_seconds=0)
            except Exception:
                detail = []
        by_team = {}
        for pick in detail or []:
            tid = str(pick.get("team_id") or "")
            name = (pick.get("name") or "").strip()
            if tid and name:
                by_team.setdefault(tid, []).append(name)
        for row in draft_order:
            if row.get("pick") not in (1, team_count):
                continue
            tid = str(row.get("team_id") or "")
            turn_teams.append({
                "slot": row.get("pick"),
                "team_name": row.get("team_name") or f"Team {tid}",
                "is_you": bool(row.get("is_you")),
                "roster": by_team.get(tid) or [],
            })
    return {
        "taken_by_pos": taken,
        "taken_total": taken_total,
        "current_overall_pick": current_overall,
        "your_slot": your_slot,
        "team_count": team_count or None,
        "slot_band": draft_slot_band(your_slot, team_count) if your_slot and team_count else "",
        "draft_type": draft_type,
        "picks_until_next": wait,
        "turn_teams": turn_teams,
        "recent_picks": [
            {"name": (p.get("name") if isinstance(p, dict) else ""), "pos": _norm_pos(p.get("pos") if isinstance(p, dict) else "")}
            for p in recent
        ],
        "recent_by_pos": _count_by_pos(recent),
        "roster_by_pos": roster,
        "starter_needs": {k: v for k, v in needs.items() if v},
        "roster_holes": _roster_holes(roster, needs),
    }


def _normalize_rb_strategy(value) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    lowered = text.lower()
    if "zero" in lowered:
        return "Zero RB"
    if "fragile" in lowered or "hyper" in lowered:
        return "Hyper-Fragile RB"
    if "robust" in lowered or "heavy" in lowered:
        return "Robust RB"
    if "hero" in lowered:
        return "Hero RB"
    return text if text in _RB_STRATEGIES else ""


_PLACEHOLDER_NAMES = {"", "player name", "string", "null", "none", "n/a", "tbd", "unknown"}


def _coerce_pick_decision(decision) -> dict:
    """Flatten nested DeepSeek pick JSON into a single {player, rationale, ...} dict."""
    if not isinstance(decision, dict):
        return {}
    out = dict(decision)
    for key in ("decision", "pick", "result", "recommendation", "data", "choice"):
        inner = out.get(key)
        if isinstance(inner, dict):
            for k, v in inner.items():
                if out.get(k) in (None, ""):
                    out[k] = v
        elif isinstance(inner, str) and inner.strip() and not out.get("player"):
            out["player"] = inner.strip()
    player = out.get("player")
    if isinstance(player, dict):
        out["player"] = (
            player.get("name") or player.get("player") or player.get("fullName") or ""
        )
    return out


def _llm_player_name(decision: dict) -> str:
    if not isinstance(decision, dict):
        return ""
    for key in ("player", "recommended_player", "name", "pick", "selection"):
        val = decision.get(key)
        if isinstance(val, dict):
            val = val.get("name") or val.get("player") or val.get("fullName") or ""
        if isinstance(val, list) and val:
            val = val[0]
            if isinstance(val, dict):
                val = val.get("name") or val.get("player") or ""
        if not isinstance(val, str):
            continue
        name = val.strip()
        if name and name.lower() not in _PLACEHOLDER_NAMES:
            return name
    return ""


def _llm_rationale(decision: dict) -> str:
    if not isinstance(decision, dict):
        return ""
    val = decision.get("rationale") or decision.get("reason") or decision.get("why") or ""
    if isinstance(val, list):
        val = " ".join(str(x) for x in val if x)
    if val in (None, "string"):
        return ""
    return str(val).strip()


def _name_already_taken(name: str, taken: list, my_team: list = None) -> str:
    """Return the matching taken/roster display name if this player is off the board."""
    if not (name or "").strip():
        return ""
    for src in (taken or []), (my_team or []):
        for item in src:
            other = (item.get("name") if isinstance(item, dict) else item) or ""
            if _names_match(name, other):
                return str(other).strip()
    return ""


def _format_player_lines(players: list) -> str:
    lines = []
    for item in players or []:
        if isinstance(item, dict):
            name = (item.get("name") or "").strip()
            pos = (item.get("pos") or "").strip()
        else:
            name, pos = str(item or "").strip(), ""
        if not name:
            continue
        lines.append(f"{name} ({pos})" if pos else name)
    return "\n".join(lines) if lines else "(none)"


def _ask_pick(
    picked: list,
    my_team: list,
    suggestion: Optional[dict],
    league_block: str,
    session_id: str = None,
    prior_strategy: str = "",
    rejected: list = None,
    blank_retry: bool = False,
    timeout: int = 75,
):
    guidance = load_guidance("system_guidance.md", "data_interpretation_guidance.md", "live_draft_guidance.md")
    sug = suggestion if isinstance(suggestion, dict) else None
    snapshot = _board_snapshot(picked, my_team, session_id=session_id)
    rejected_names = [n for n in (rejected or []) if n]
    rejected_block = ""
    if rejected_names:
        rejected_block = (
            "ALREADY TAKEN — do not name these; pick someone else still available:\n"
            + "\n".join(rejected_names)
            + "\n"
        )
    if blank_retry:
        rejected_block += (
            'Your previous reply had an empty "player". '
            "Name one real available player. If unsure, use the Autodraft suggestion and set use_autodraft true.\n"
        )
    prompt = f"""
{guidance}

DECISION: name exactly one player to draft right now. That player must not be on TAKEN PLAYERS or CURRENT ROSTER. Prefer the Autodraft suggestion when it is a sound pick. Use pick slot (early/middle/late), taken players, current roster, and board snapshot for scarcity, runs, and the wait until the next pick. Stay flexible early; once the board dictates a path, commit to Hero RB, Robust RB, Zero RB, or Hyper-Fragile RB (including that approach's QB/TE pairing) and stick with it unless a massive run forces a pivot.

---

{league_block}

TAKEN PLAYERS (off the board):
{_format_player_lines(picked)}

CURRENT ROSTER:
{_format_player_lines(my_team)}

AUTODRAFT SUGGESTION:
{json.dumps(sug, ensure_ascii=False)}

BOARD SNAPSHOT:
{json.dumps(snapshot, ensure_ascii=False)}

PRIOR RB STRATEGY:
{prior_strategy or "none yet"}
{rejected_block}
Reply with one JSON object only, after any thinking. "player" must be a real available name, never blank:
{{"player": "First Last", "pos": "RB", "use_autodraft": false, "rb_strategy": "Hero RB", "rationale": "short why"}}
"""
    parsed = _coerce_pick_decision(
        query_local_deepseek(prompt, session_id=session_id, timeout=max(1, int(timeout))) or {}
    )
    return parsed, prompt.strip()


def _job_snapshot(session_id: str) -> dict:
    with _JOBS_LOCK:
        job = _JOBS.get(session_id or "") or {}
    return {
        "running": bool(job.get("running")),
        "message": job.get("message") or "",
        "last_pick": job.get("last_pick") or "",
        "picks": int(job.get("picks") or 0),
        "rb_strategy": job.get("rb_strategy") or "",
        "error": job.get("error") or "",
        "draft_url": job.get("draft_url") or "",
    }


def _set_job(session_id: str, **kwargs):
    key = session_id or ""
    with _JOBS_LOCK:
        job = _JOBS.setdefault(key, {
            "running": False,
            "stop": threading.Event(),
            "message": "",
            "last_pick": "",
            "picks": 0,
            "rb_strategy": "",
            "error": "",
            "draft_url": "",
            "taken_by_id": {},
        })
        job.update(kwargs)


def live_draft_status(session_id: str = None) -> dict:
    return _job_snapshot(session_id)


def stop_live_draft(session_id: str = None) -> dict:
    _set_job(session_id, message="Stopping…")
    with _JOBS_LOCK:
        job = _JOBS.get(session_id or "")
        if job and job.get("stop"):
            job["stop"].set()
    return _job_snapshot(session_id)


def start_live_draft(draft_url: str = None, session_id: str = None) -> dict:
    """Start a background live/mock draft loop. Returns current status."""
    key = session_id or ""
    with _JOBS_LOCK:
        existing = _JOBS.get(key)
        if existing and existing.get("running"):
            raise RuntimeError("A live draft is already running for this session. Stop it first.")
        stop = threading.Event()
        _JOBS[key] = {
            "running": True,
            "stop": stop,
            "message": "Starting draft room…",
            "last_pick": "",
            "picks": 0,
            "rb_strategy": "",
            "error": "",
            "draft_url": (draft_url or "").strip(),
            "taken_by_id": {},
        }
    thread = threading.Thread(
        target=_live_draft_thread,
        kwargs={"draft_url": draft_url, "session_id": session_id},
        daemon=True,
        name=f"live-draft-{key or 'default'}",
    )
    thread.start()
    return _job_snapshot(session_id)


def _live_draft_thread(draft_url: str = None, session_id: str = None):
    try:
        run_live_draft_loop(draft_url=draft_url, session_id=session_id)
    except Exception as e:
        logging.exception("Live draft stopped with error")
        _set_job(session_id, running=False, error=str(e), message=str(e))
        log_system_event("LIVE_DRAFT_ERROR", str(e), {"error": str(e)}, session_id=session_id)


@playwright_sync
def run_live_draft_loop(draft_url: str = None, session_id: str = None):
    url = _live_draft_url(draft_url, session_id=session_id)
    _set_job(session_id, draft_url=url, message="Opening ESPN draft room…", error="")
    league_block = _league_block(session_id=session_id)
    if not league_block.strip():
        raise RuntimeError(
            "League settings are missing. Run Setup Draft Strategy once, or save League ID / Team ID under ESPN Connection."
        )

    log_system_event("LIVE_DRAFT_START", f"Opening draft room {url}", {"draft_url": url}, session_id=session_id)
    stop = None
    with _JOBS_LOCK:
        stop = (_JOBS.get(session_id or "") or {}).get("stop")

    with sync_playwright() as p:
        profile_dir = os.path.join(os.environ.get("TEMP", "C:/tmp"), "espn_openclaw_profile")
        browser = p.chromium.launch_persistent_context(
            user_data_dir=profile_dir,
            headless=False,
            args=["--disable-blink-features=AutomationControlled"],
        )
        try:
            page = browser.new_page()
            page.goto(url, wait_until="domcontentloaded", timeout=90000)
            page.wait_for_timeout(4000)
            ensure_espn_login(page, session_id=session_id)

            if _is_page_not_found(page):
                raise RuntimeError(
                    "ESPN couldn't find a draft room at that URL. Check the live/mock link and that the draft has started."
                )

            _set_job(session_id, message="Turning Autopick off…")
            if _ensure_autopick_off(page):
                log_system_event("LIVE_DRAFT_AUTOPICK_OFF", "Autopick is off", session_id=session_id)
            _set_job(session_id, message="Waiting for your turn (watching Autopick)…")
            idle_rounds = 0
            while True:
                if stop and stop.is_set():
                    _set_job(session_id, running=False, message="Stopped.")
                    break

                if _autopick_is_on(page):
                    _set_job(session_id, message="Autopick came on — turning it off…")
                    _disable_autopick(page)
                    page.wait_for_timeout(250)
                    if not _autopick_is_on(page):
                        log_system_event("LIVE_DRAFT_AUTOPICK_OFF", "Autopick was on; turned it off", session_id=session_id)
                        continue

                state = _scrape(page)
                if state["draft_complete"]:
                    _set_job(session_id, running=False, message="Draft complete.")
                    log_system_event("LIVE_DRAFT_COMPLETE", "Draft room reports complete", session_id=session_id)
                    break

                if not state["my_turn"]:
                    idle_rounds += 1
                    _set_job(session_id, message="Waiting for your turn…")
                    page.wait_for_timeout(400)
                    if idle_rounds > 30000:  # ~3.3 hours at 400ms
                        _set_job(session_id, running=False, message="Timed out waiting for picks.")
                        break
                    continue

                idle_rounds = 0
                pick_started = time.monotonic()
                pick_timed_out = False
                if _autopick_is_on(page):
                    _ensure_autopick_off(page, attempts=4)
                suggestion = state.get("autodraft_suggestion") or {}
                sug_name = (suggestion.get("name") or "").strip()
                taken = _merge_taken(state["picked"], session_id=session_id)

                with _JOBS_LOCK:
                    prior_strategy = ((_JOBS.get(session_id or "") or {}).get("rb_strategy") or "")

                rejected = []
                taken_attempts = []
                decision = {}
                prompt_sent = ""
                llm_player = ""
                blank_replies = 0
                max_llm_tries = 3
                for try_n in range(max_llm_tries):
                    if stop and stop.is_set():
                        break
                    remaining = _PICK_DEADLINE_SECONDS - (time.monotonic() - pick_started)
                    if remaining < 3:
                        pick_timed_out = True
                        logging.warning(
                            f"Live draft: {_PICK_DEADLINE_SECONDS}s pick budget exhausted; skipping this turn"
                        )
                        break
                    if try_n > 0:
                        state = _scrape(page)
                        suggestion = state.get("autodraft_suggestion") or {}
                        sug_name = (suggestion.get("name") or "").strip()
                        taken = _merge_taken(state["picked"], session_id=session_id)
                    if try_n == 0:
                        msg = "Your turn — asking DeepSeek…"
                    elif rejected:
                        msg = f"{rejected[-1]} is taken — asking DeepSeek again…"
                    else:
                        msg = "Blank DeepSeek pick — asking again…"
                    _set_job(session_id, message=msg)
                    decision, prompt_sent = _ask_pick(
                        taken,
                        state["my_team"],
                        suggestion or None,
                        league_block,
                        session_id=session_id,
                        prior_strategy=prior_strategy,
                        rejected=rejected,
                        blank_retry=blank_replies > 0,
                        timeout=max(1, remaining - 0.5),
                    )
                    if time.monotonic() - pick_started >= _PICK_DEADLINE_SECONDS:
                        pick_timed_out = True
                        logging.warning(
                            f"Live draft: DeepSeek over {_PICK_DEADLINE_SECONDS}s; skipping this turn"
                        )
                        break
                    llm_player = _llm_player_name(decision)
                    hit = _name_already_taken(llm_player, taken, state["my_team"])
                    taken_attempts.append({
                        "player": llm_player,
                        "already_taken": bool(hit),
                        "blank": not bool(llm_player),
                        "matched_taken": hit,
                        "parsed_keys": list(decision)[:12] if isinstance(decision, dict) else [],
                    })
                    if not llm_player:
                        blank_replies += 1
                        logging.warning("Live draft: DeepSeek returned a blank player; re-prompting")
                        continue
                    if hit:
                        logging.warning(
                            f"Live draft: DeepSeek named taken player {llm_player} (matched {hit}); re-prompting"
                        )
                        if llm_player not in rejected:
                            rejected.append(llm_player)
                        continue
                    break

                if stop and stop.is_set():
                    _set_job(session_id, running=False, message="Stopped.")
                    break

                if not pick_timed_out and (time.monotonic() - pick_started) >= _PICK_DEADLINE_SECONDS:
                    pick_timed_out = True

                if pick_timed_out:
                    elapsed = time.monotonic() - pick_started
                    _set_job(
                        session_id,
                        message="DeepSeek too slow — Autodraft will take this pick…",
                    )
                    log_action(
                        week=0,
                        action_type="LIVE_DRAFT_PICK",
                        starters=[],
                        bench=["timeout"],
                        rationale=(
                            f"Skipped: DeepSeek took {elapsed:.1f}s "
                            f"(limit {_PICK_DEADLINE_SECONDS}s). Autodraft handles this pick."
                        ),
                        status="SKIPPED",
                        prompt_sent=prompt_sent,
                        raw_response=json.dumps({
                            "timed_out": True,
                            "elapsed_seconds": round(elapsed, 2),
                            "deadline_seconds": _PICK_DEADLINE_SECONDS,
                            "taken_attempts": taken_attempts,
                            "autodraft_suggestion": suggestion,
                        }, ensure_ascii=False),
                        session_id=session_id,
                    )
                    log_system_event(
                        "LIVE_DRAFT_PICK_TIMEOUT",
                        f"Skipped pick after {elapsed:.1f}s; waiting for Autodraft",
                        {"elapsed_seconds": round(elapsed, 2)},
                        session_id=session_id,
                    )
                    while True:
                        if stop and stop.is_set():
                            break
                        nxt = _scrape(page)
                        if nxt.get("draft_complete") or not nxt.get("my_turn"):
                            break
                        page.wait_for_timeout(400)
                    if stop and stop.is_set():
                        _set_job(session_id, running=False, message="Stopped.")
                        break
                    continue

                deepseek_player = llm_player or next(
                    (a.get("player") or "" for a in reversed(taken_attempts) if a.get("player")),
                    "",
                )
                still_taken = bool(llm_player and _name_already_taken(llm_player, taken, state["my_team"]))
                if still_taken:
                    logging.warning(
                        f"Live draft: DeepSeek still naming taken player {llm_player} after {len(taken_attempts)} tries"
                    )
                    llm_player = ""

                llm_use_auto = bool(decision.get("use_autodraft")) if isinstance(decision, dict) else False
                llm_rationale = _llm_rationale(decision)
                rb_strategy = _normalize_rb_strategy(
                    (decision.get("rb_strategy") or decision.get("strategy") if isinstance(decision, dict) else "")
                    or prior_strategy
                )
                matched_autodraft = bool(sug_name and llm_player and _names_match(llm_player, sug_name))
                if not llm_player and not sug_name:
                    logging.warning("Live draft: no player from DeepSeek and no Autodraft suggestion.")
                    page.wait_for_timeout(2000)
                    continue

                if _autopick_is_on(page):
                    _ensure_autopick_off(page, attempts=4)

                try_banner_first = llm_use_auto or matched_autodraft or not llm_player
                draft_target = sug_name if try_banner_first else llm_player
                _set_job(session_id, message=f"Drafting {draft_target or llm_player}…")

                clicked = False
                via = "none"
                miss_reasons = []
                drafted = ""
                if rejected:
                    miss_reasons.append(
                        "DeepSeek first named taken player"
                        + ("s " if len(rejected) > 1 else " ")
                        + ", ".join(f"'{n}'" for n in rejected)
                        + ("." if llm_player else "; no available replacement, falling back to Autodraft.")
                    )
                if blank_replies and not llm_player:
                    miss_reasons.append(
                        f"DeepSeek returned a blank player on {blank_replies} attempt"
                        + ("s." if blank_replies != 1 else ".")
                    )

                if try_banner_first:
                    clicked = _click_banner_draft(page)
                    if clicked:
                        via = "banner"
                        drafted = sug_name or llm_player
                    else:
                        miss_reasons.append("Banner DRAFT click failed for the Autodraft suggestion.")
                if not clicked and llm_player:
                    clicked = _click_table_draft(page, llm_player)
                    if clicked:
                        via = "table"
                        drafted = llm_player
                    else:
                        miss_reasons.append(
                            f"Could not find or click DRAFT for DeepSeek pick '{llm_player}' in the available-players table."
                        )
                if not clicked and sug_name:
                    clicked = _click_banner_draft(page)
                    if clicked:
                        via = "banner-fallback"
                        drafted = sug_name
                        if llm_player and not matched_autodraft:
                            miss_reasons.append(
                                f"Fell back to Autodraft '{sug_name}' because DeepSeek's '{llm_player}' could not be drafted."
                            )
                        elif not miss_reasons:
                            miss_reasons.append(
                                "First Autodraft banner click failed; fallback banner click succeeded."
                            )
                if not drafted:
                    drafted = sug_name or llm_player

                used_autodraft = via.startswith("banner")
                why_not_picked = " ".join(miss_reasons).strip()
                rationale = llm_rationale or (
                    "Took Autodraft suggestion." if used_autodraft else f"Drafted {drafted}."
                )
                if rb_strategy and rb_strategy.lower() not in rationale.lower():
                    rationale = f"{rb_strategy}: {rationale}"
                if used_autodraft and not rationale.lower().startswith("autodraft"):
                    rationale = f"Autodraft: {rationale}"
                if llm_player and drafted and not _names_match(llm_player, drafted):
                    rationale = f"{rationale} DeepSeek wanted {llm_player}."
                if why_not_picked:
                    rationale = f"{rationale} {why_not_picked}"

                bench = [via]
                if rb_strategy:
                    bench.append(rb_strategy)
                if deepseek_player:
                    bench.append(f"DeepSeek: {deepseek_player}")
                if why_not_picked:
                    bench.append(why_not_picked)

                log_action(
                    week=0,
                    action_type="LIVE_DRAFT_PICK",
                    starters=[drafted],
                    bench=bench,
                    rationale=rationale,
                    status="EXECUTED" if clicked else "EXECUTION_FAILED",
                    prompt_sent=prompt_sent,
                    raw_response=json.dumps({
                        "deepseek": {
                            "player": deepseek_player,
                            "use_autodraft": llm_use_auto,
                            "rb_strategy": rb_strategy,
                            "rationale": llm_rationale,
                        },
                        "autodraft_suggestion": suggestion,
                        "name_matched_autodraft": matched_autodraft,
                        "drafted": drafted,
                        "use_autodraft": used_autodraft,
                        "via": via,
                        "clicked": clicked,
                        "why_not_picked": why_not_picked,
                        "rejected_taken": rejected,
                        "taken_attempts": taken_attempts,
                    }, ensure_ascii=False),
                    session_id=session_id,
                )
                if clicked:
                    with _JOBS_LOCK:
                        job = _JOBS.get(session_id or "") or {}
                        job["picks"] = int(job.get("picks") or 0) + 1
                        job["last_pick"] = drafted
                        job["rb_strategy"] = rb_strategy
                        job["message"] = (
                            f"Picked {drafted}"
                            + (f" ({rb_strategy})" if rb_strategy else "")
                            + ". Waiting for next turn…"
                        )
                    page.wait_for_timeout(2500)
                    for _ in range(20):
                        if stop and stop.is_set():
                            break
                        nxt = _scrape(page)
                        if not nxt["my_turn"]:
                            break
                        page.wait_for_timeout(500)
                else:
                    _set_job(session_id, message=f"Could not click DRAFT for {llm_player or drafted}.")
                    page.wait_for_timeout(2000)
        finally:
            browser.close()

    _set_job(session_id, running=False)
    if not (_job_snapshot(session_id).get("message")):
        _set_job(session_id, message="Draft assistant finished.")


def run_live_draft_assistant(draft_url: str = None, session_id: str = None):
    """Start the live/mock draft loop. Picks are always executed in-room."""
    return start_live_draft(draft_url=draft_url, session_id=session_id)
