"""
ESPN Pre-Draft Strategy helpers.

Builds a top-N pre-draft ranking with DeepSeek using nflreadpy (injury-aware;
high-ceiling injured players may still be ranked), then writes it to ESPN:

  POST lm-api-writes.../leagues/{leagueId}/teams/{teamId}
  Body: {"draftStrategy":{"draftList":[{"playerId":...},...],"excludedPlayerIds":[]}}

Page (for humans): https://fantasy.espn.com/football/editdraftstrategy?leagueId={id}
"""

from __future__ import annotations

import datetime
import json
import logging
import os
import re
from typing import Iterable, List, Optional

import pandas as pd
import requests

from src.helpers.db_manager import log_action, log_system_event, save_espn_settings
from src.helpers.espn_client import (
    fetch_espn_ir_eligible_players,
    fetch_espn_league_settings,
    format_draft_order_block,
    format_league_settings_block,
    get_saved_league_settings_block,
    resolve_espn_settings,
)
from src.helpers.llm_client import query_local_deepseek
from src.helpers.nfl_data_client import (
    draft_stats_season,
    fantasy_espn_season,
    get_injury_history_by_player,
    get_seasonal_stats,
    refresh_espn_id_crosswalk,
)
from src.helpers.prompt_loader import load_guidance
import nflreadpy as nfl

# Prior seasons of nflverse injury reports attached for LLM durability context.
_INJURY_HISTORY_SEASONS = 3


def _to_pandas(frame):
    if frame is None:
        return pd.DataFrame()
    if isinstance(frame, pd.DataFrame):
        return frame
    return frame.to_pandas()

WRITE_HEADERS = {
    "Content-Type": "application/json",
    "x-fantasy-platform": "espn-fantasy-web",
    "x-fantasy-source": "kona",
}

_SKILL_POSITIONS = {"QB", "RB", "WR", "TE", "K", "FB"}
_CANDIDATE_POOL_SIZE = 220  # DeepSeek ranks top N from this pool

# ESPN Autopick roundStrategy.positionIds and positionStrategy.positionId use
# PLAYER defaultPositionId, not lineup slot ids. Lineup 0=QB / 4=WR / 6=TE /
# 17=K / 23=FLEX 400 as positionIds (RB=2 and DST=16 happen to overlap).
_PLAYER_POS_IDS = {
    "QB": 1,
    "RB": 2,
    "WR": 3,
    "TE": 4,
    "K": 5,
    "DST": 16,
    "D/ST": 16,
}
POSITION_PREF = {
    "BEST_AVAILABLE": -1,
    **_PLAYER_POS_IDS,
    "FLEX": -1,
    "OP": -1,
}
_AUTOPICK_POSITION_IDS = frozenset({-1, 1, 2, 3, 4, 5, 16})
_FLEX_ROUND_POSITION_IDS = (2, 3, 4)  # RB, WR, TE player positions
_OP_ROUND_POSITION_IDS = (1, 2, 3, 4)  # Superflex / OP
_POS_TO_PREF = {
    "QB": "QB",
    "RB": "RB",
    "WR": "WR",
    "TE": "TE",
    "K": "K",
    "FB": "RB",
    "DST": "DST",
    "D/ST": "DST",
}

# ESPN lineupSlotId -> Autopick preference (None = bench/IR filler).
_SLOT_ID_TO_PREF = {
    0: "QB",
    2: "RB",
    4: "WR",
    6: "TE",
    7: "OP",     # Superflex
    3: "FLEX",   # RB/WR/TE
    16: "DST",
    17: "K",
    23: "FLEX",
    24: "FLEX",  # RB/WR
    25: "FLEX",  # WR/TE
    20: None,    # Bench
    21: None,    # IR
}

# Emit required starters in this order (skill scarcity first; K/DST last).
_STARTER_EMIT_ORDER = ["RB", "WR", "TE", "FLEX", "OP", "QB", "DST", "K"]

# Autopick Position Limits table (player positions only — Flex is not a row).
_LIMIT_POSITIONS = ("QB", "RB", "WR", "TE", "DST", "K")
# Extra on top of starter mins. QB/K/DST extras are chosen by the LLM (0 or 1).
_LIMIT_MAX_EXTRA = {"QB": 0, "RB": 6, "WR": 6, "TE": 1, "DST": 0, "K": 0}
_POS_MAX_JSON_KEYS = {
    "QB": ("max_qb", "qb_count", "qb_strategy"),
    "K": ("max_k", "max_kicker", "k_count", "kicker_count"),
    "DST": ("max_dst", "max_def", "dst_count", "def_count"),
}
_POS_MAX_PREF_MATCH = {
    "QB": ("QB", "OP"),
    "K": ("K",),
    "DST": ("DST",),
}

# IR-Eligible on ESPN = Out / Injured Reserve (site Health filter).
_INJURED_STATUSES = {
    "out",
    "ir",
    "injury_reserve",
    "injured reserve",
}


def draft_strategy_url(league_id: str) -> str:
    return f"https://fantasy.espn.com/football/editdraftstrategy?leagueId={league_id}"


def _season() -> int:
    return fantasy_espn_season()


def _cookies(session_id: str = None) -> dict:
    settings = resolve_espn_settings(session_id=session_id)
    return {"espn_s2": settings["espn_s2"], "SWID": settings["swid"]}


def _team_write_url(league_id: str, team_id: str, season: int = None) -> str:
    season = season or _season()
    return (
        f"https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/"
        f"segments/0/leagues/{league_id}/teams/{team_id}"
    )


def _normalize_name(name: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", (name or "").lower()).strip()


def _is_injured(status: str) -> bool:
    if not status:
        return False
    return status.strip().lower() in _INJURED_STATUSES


def build_draft_candidates(season: int = None, pool_size: int = None, session_id: str = None) -> list:
    """
    Build an ordered candidate pool from nflreadpy production + ESPN ids,
    with current injury from ESPN IR-Eligible and past injury history from
    cached nflverse reports (for LLM risk/ceiling context).
    """
    season = season or _season()
    pool_size = pool_size or _CANDIDATE_POOL_SIZE
    stats_season = draft_stats_season(season)

    refresh_espn_id_crosswalk(session_id=session_id)
    ids_df = _to_pandas(nfl.load_ff_playerids())
    ids_df = ids_df.dropna(subset=["espn_id", "gsis_id", "name"]).copy()
    ids_df["espn_id"] = ids_df["espn_id"].apply(lambda x: int(float(x)))
    ids_df["position"] = ids_df["position"].fillna("").astype(str).str.upper()
    ids_df = ids_df[ids_df["position"].isin(_SKILL_POSITIONS)]

    # Fantasy year N drafts before NFL year-N games exist — use N-1 production.
    try:
        seasonal_df, resolved_season = get_seasonal_stats(stats_season, session_id=session_id)
    except Exception:
        seasonal_df, resolved_season = get_seasonal_stats(stats_season - 1, session_id=session_id)

    fp_col = "fantasy_points_ppr" if "fantasy_points_ppr" in seasonal_df.columns else (
        "fantasy_points" if "fantasy_points" in seasonal_df.columns else None
    )
    id_col = "player_id" if "player_id" in seasonal_df.columns else "gsis_id"
    pts_map = {}
    if fp_col and id_col in seasonal_df.columns:
        for row in seasonal_df.itertuples():
            pid = getattr(row, id_col, None)
            pts = getattr(row, fp_col, None)
            if pid and pts is not None and not (isinstance(pts, float) and pd.isna(pts)):
                pts_map[pid] = float(pts)

    # ESPN site source of truth for who is IR-Eligible / injured right now.
    try:
        espn_injury = fetch_espn_ir_eligible_players(session_id=session_id)
    except Exception as e:
        logging.warning(f"Could not load ESPN IR-Eligible list ({e}); treating all as ACTIVE.")
        espn_injury = {}

    # Past seasons: disk-cached nflverse injury reports for LLM durability context.
    hist_seasons = [stats_season - i for i in range(0, _INJURY_HISTORY_SEASONS) if stats_season - i >= 2010]
    gsis_all = set(ids_df["gsis_id"].dropna().tolist())
    try:
        injury_hist = get_injury_history_by_player(hist_seasons, gsis_ids=gsis_all, session_id=session_id)
    except Exception as e:
        logging.warning(f"Could not load nflverse injury history ({e}).")
        injury_hist = {}

    candidates = []
    seen_espn = set()
    for row in ids_df.itertuples():
        gsis = row.gsis_id
        espn_id = int(row.espn_id)
        if espn_id in seen_espn:
            continue
        inj = espn_injury.get(str(espn_id)) or {}
        # Prefer IR-Eligible (Out/IR). Still surface Questionable etc. when present.
        if inj.get("ir_eligible"):
            status = inj.get("injury_status") or "Out"
        elif inj.get("injury_status"):
            status = inj["injury_status"]
        else:
            status = "ACTIVE"
        hist = injury_hist.get(gsis) or {}
        seen_espn.add(espn_id)
        candidates.append({
            "name": row.name,
            "pos": row.position,
            "team": getattr(row, "team", None) or "",
            "espn_id": espn_id,
            "gsis_id": gsis,
            "prior_ppr": round(pts_map.get(gsis, 0.0), 1),
            "prior_ppr_season": int(resolved_season),
            "stats_context": (
                f"prior_ppr is {resolved_season} completed-season PPR; "
                f"{season} regular-season games have not been played yet."
            ),
            "injury_status": status,
            "ir_eligible": bool(inj.get("ir_eligible")),
            "is_injured": bool(inj.get("ir_eligible")) or _is_injured(status),
            "injury_history": hist.get("summary") or "",
            "injury_history_detail": hist.get("seasons") or [],
        })

    candidates.sort(key=lambda p: (p["is_injured"], -p["prior_ppr"], p["name"]))
    selected = []
    per_pos_cap = {"QB": 30, "RB": 70, "WR": 90, "TE": 30, "K": 15, "FB": 5}
    pos_counts = {k: 0 for k in per_pos_cap}
    for p in candidates:
        pos = p["pos"] if p["pos"] in per_pos_cap else "WR"
        if pos_counts[pos] >= per_pos_cap[pos]:
            continue
        selected.append(p)
        pos_counts[pos] += 1
        if len(selected) >= pool_size:
            break

    if len(selected) < pool_size:
        have = {p["espn_id"] for p in selected}
        for p in candidates:
            if p["espn_id"] in have:
                continue
            selected.append(p)
            if len(selected) >= pool_size:
                break

    injured_in_pool = sum(1 for p in selected if p["is_injured"])
    with_hist = sum(1 for p in selected if p.get("injury_history"))
    logging.info(
        f"Built {len(selected)} draft candidates for fantasy {season} "
        f"(using completed-season stats {resolved_season}; {injured_in_pool} ESPN IR-Eligible, "
        f"{with_hist} with nflverse injury history from {hist_seasons})."
    )
    return selected


# Back-compat alias for older call sites / imports.
build_healthy_draft_candidates = build_draft_candidates


def _normalize_pref(pref: str) -> str:
    key = (pref or "BEST_AVAILABLE").strip().upper().replace(" ", "_")
    aliases = {
        "BEST": "BEST_AVAILABLE",
        "BA": "BEST_AVAILABLE",
        "BESTAVAILABLE": "BEST_AVAILABLE",
        "DEF": "DST",
        "D": "DST",
        "D/ST": "DST",
        "PK": "K",
        "RB/WR/TE": "FLEX",
        "RBWRTE": "FLEX",
        "SUPERFLEX": "OP",
        "SFLEX": "OP",
        "SFLX": "OP",
    }
    key = aliases.get(key, key)
    if key not in POSITION_PREF:
        return "BEST_AVAILABLE"
    return key


def _autopick_position_id(pref: str) -> int:
    """Primary ESPN player-position id (Flex/OP are multi-id)."""
    key = _normalize_pref(pref)
    if key in ("FLEX", "OP"):
        return -1
    pid = _PLAYER_POS_IDS.get(key, -1)
    if pid not in _AUTOPICK_POSITION_IDS:
        return -1
    return pid


def _round_strategy_position_ids(pref: str) -> list:
    """positionIds for one Autopick round. Player positions, not lineup slots."""
    key = _normalize_pref(pref)
    if key == "FLEX":
        return list(_FLEX_ROUND_POSITION_IDS)
    if key == "OP":
        return list(_OP_ROUND_POSITION_IDS)
    pid = _autopick_position_id(pref)
    return [pid]


def _pref_label(pref: str) -> str:
    key = _normalize_pref(pref)
    if key == "FLEX":
        return "Flex"
    if key == "OP":
        return "OP"
    if key == "BEST_AVAILABLE":
        return "Best Available"
    if key == "DST":
        return "D/ST"
    return key


def _parse_invalid_strategy_position(resp) -> Optional[int]:
    text = resp.text or ""
    blobs = [text]
    try:
        data = resp.json()
        blobs.extend(data.get("messages") or [])
        for detail in data.get("details") or []:
            if isinstance(detail, dict):
                blobs.append(detail.get("message") or "")
    except Exception:
        pass
    blob = " ".join(str(b) for b in blobs if b)
    match = re.search(r"position\s+(\d+)\s+does not exist", blob, re.I)
    if match:
        return int(match.group(1))
    return None


def _slot_counts_from_league(league_settings: dict) -> dict:
    """
    Return Autopick-pref counts required by league roster rules.
    Keys: QB/RB/WR/TE/FLEX/DST/K plus "BENCH" for bench slots.
    """
    counts = {p: 0 for p in _STARTER_EMIT_ORDER}
    counts["BENCH"] = 0

    raw = (league_settings or {}).get("raw") or {}
    slot_counts = (raw.get("rosterSettings") or {}).get("lineupSlotCounts") or {}
    if slot_counts:
        for slot_id_str, n in slot_counts.items():
            try:
                slot_id = int(slot_id_str)
                n = int(n)
            except (TypeError, ValueError):
                continue
            if n <= 0:
                continue
            pref = _SLOT_ID_TO_PREF.get(slot_id)
            if pref is None:
                if slot_id == 20:
                    counts["BENCH"] += n
                continue
            counts[pref] = counts.get(pref, 0) + n
        return counts

    # Fallback: parse "1 QB, 2 RB, ..." roster_settings string.
    roster = (league_settings or {}).get("roster_settings") or ""
    label_map = {
        "QB": "QB", "RB": "RB", "WR": "WR", "TE": "TE",
        "FLEX": "FLEX", "OP": "FLEX", "D/ST": "DST", "DST": "DST",
        "DEF": "DST", "K": "K", "BENCH": "BENCH",
    }
    for count_s, label in re.findall(r"(\d+)\s+([A-Za-z0-9/]+)", roster):
        pref = label_map.get(label.upper())
        if pref:
            counts[pref] = counts.get(pref, 0) + int(count_s)
    return counts


def _required_starter_prefs(league_settings: dict) -> list:
    """Ordered Autopick prefs that cover every required starter slot once."""
    counts = _slot_counts_from_league(league_settings)
    prefs = []
    for pref in _STARTER_EMIT_ORDER:
        prefs.extend([pref] * int(counts.get(pref) or 0))
    return prefs


def _league_roster_position_limits(league_settings: dict) -> dict:
    """League roster max by lineup slot id (0=QB, 2=RB, ...). -1 = unlimited."""
    raw = (league_settings or {}).get("raw") or {}
    limits = (raw.get("rosterSettings") or {}).get("positionLimits") or {}
    out = {}
    for key, val in limits.items():
        try:
            out[int(key)] = int(val)
        except (TypeError, ValueError):
            continue
    return out


def _position_mins_from_league(league_settings: dict) -> dict:
    """Starter counts per Autopick player position. OP/superflex counts as QB."""
    counts = _slot_counts_from_league(league_settings)
    mins = {p: int(counts.get(p) or 0) for p in _LIMIT_POSITIONS}
    raw = (league_settings or {}).get("raw") or {}
    slots = (raw.get("rosterSettings") or {}).get("lineupSlotCounts") or {}
    try:
        op_n = int(slots.get("7") or slots.get(7) or 0)
    except (TypeError, ValueError):
        op_n = 0
    if op_n > 0:
        mins["QB"] = mins.get("QB", 0) + op_n
    return mins


def _position_strategy_from_league(league_settings: dict, maxes: dict = None) -> list:
    """
    ESPN Autopick Position Limits: [{positionId, minimum, maximum}, ...]
    for every table row (QB/RB/WR/TE/K/DST). positionId is the player
    defaultPositionId (1=QB, 3=WR, 5=K), not the lineup slot.
    maxes may override QB/K/DST when the LLM chooses starter-only vs one extra.
    """
    mins = _position_mins_from_league(league_settings)
    league_max = _league_roster_position_limits(league_settings)
    maxes = maxes or {}
    rows = []
    for pref in _LIMIT_POSITIONS:
        minimum = int(mins.get(pref) or 0)
        extra = int(_LIMIT_MAX_EXTRA.get(pref) or 0)
        maximum = minimum + extra
        if pref in maxes and maxes[pref] is not None:
            maximum = int(maxes[pref])
        pid = _PLAYER_POS_IDS[pref]
        cap = league_max.get(pid)
        if cap is not None and cap > 0:
            maximum = min(maximum, cap)
        maximum = max(maximum, minimum)
        rows.append({
            "positionId": pid,
            "minimum": minimum,
            "maximum": maximum,
        })
    return rows


def _position_strategy_label(rows: list) -> str:
    id_to_pref = {v: k for k, v in _PLAYER_POS_IDS.items() if k in _LIMIT_POSITIONS}
    labels = []
    for row in rows or []:
        pref = id_to_pref.get(row.get("positionId"))
        if not pref:
            continue
        labels.append(f"{pref} {row.get('minimum')}-{row.get('maximum')}")
    return ", ".join(labels)


def _autopick_pick_count(league_settings: dict) -> int:
    """ESPN Autopick rows = starters + bench (not IR, not ranking length)."""
    counts = _slot_counts_from_league(league_settings)
    starters = sum(int(counts.get(p) or 0) for p in _STARTER_EMIT_ORDER)
    bench = int(counts.get("BENCH") or 0)
    return max(starters + bench, 1)


def _prefs_covering_league(
    league_settings: dict,
    ranked: list,
    pick_count: int,
) -> list:
    """
    Build pick-by-pick Autopick prefs that:
      1) Cover every league-required starter slot (QB/RB/WR/TE/FLEX/DST/K),
      2) Use BEST_AVAILABLE for bench and remaining slots.

    Extra QBs/K/DST during BA rounds are blocked by Autopick positionStrategy
    maxes (e.g. max 2 QB, max 1 K, max 1 DST), not by forcing Flex.
    """
    del ranked  # board order is separate; prefs enforce league roster construction
    pick_count = _autopick_pick_count(league_settings)
    starters = _required_starter_prefs(league_settings)
    counts = _slot_counts_from_league(league_settings)
    bench_n = int(counts.get("BENCH") or 0)

    prefs = list(starters)
    prefs.extend(["BEST_AVAILABLE"] * bench_n)

    while len(prefs) < pick_count:
        prefs.append("BEST_AVAILABLE")
    prefs = prefs[:pick_count]

    missing = []
    for pref in _STARTER_EMIT_ORDER:
        need = int(counts.get(pref) or 0)
        have = prefs.count(pref)
        if need and have < need:
            missing.append(f"{pref} need {need} have {have}")
    if missing:
        logging.warning(f"Pick-by-pick prefs under-cover league slots: {missing}")

    return prefs


def _prefs_from_ranked(ranked: list, pick_count: int) -> list:
    """Legacy helper: derive prefs only from ranked player positions."""
    prefs = []
    for i in range(pick_count):
        if i < len(ranked):
            pos = (ranked[i].get("pos") or "").upper()
            prefs.append(_POS_TO_PREF.get(pos, "BEST_AVAILABLE"))
        else:
            prefs.append("BEST_AVAILABLE")
    return prefs


def _parse_one_pref(value) -> str:
    if isinstance(value, dict):
        value = (
            value.get("preference")
            or value.get("pref")
            or value.get("position")
            or value.get("pos")
            or ""
        )
    return _normalize_pref(str(value or ""))


def _prefs_from_llm(decision: dict) -> list:
    """Read pick-by-pick prefs from a DeepSeek JSON object."""
    raw = (
        decision.get("pick_by_pick")
        or decision.get("pickByPick")
        or decision.get("autopick")
        or decision.get("round_strategy")
        or []
    )
    if isinstance(raw, dict):
        def _key(item):
            k = item[0]
            try:
                return int(k)
            except (TypeError, ValueError):
                return 0
        raw = [v for _, v in sorted(raw.items(), key=_key)]
    if not isinstance(raw, list):
        return []
    return [_parse_one_pref(item) for item in raw]


def _pos_starter_min(league_settings: dict, pref: str) -> int:
    n = int(_position_mins_from_league(league_settings).get(pref) or 0)
    if pref == "QB":
        return max(n, 1)
    return n


def _parse_pos_max(decision: dict, prefs: list, league_settings: dict, pref: str) -> int:
    """LLM choice: starter-only vs one extra at QB/K/DST, weighed against Flex."""
    pmin = _pos_starter_min(league_settings, pref)
    if pmin <= 0:
        return 0
    phi = pmin + 1
    raw = None
    if isinstance(decision, dict):
        for key in _POS_MAX_JSON_KEYS.get(pref) or ():
            if decision.get(key) is not None:
                raw = decision.get(key)
                break
    parsed = None
    if isinstance(raw, bool):
        parsed = phi if raw else pmin
    elif isinstance(raw, (int, float)) and not isinstance(raw, bool):
        parsed = int(raw)
    elif isinstance(raw, str):
        s = raw.strip().lower().replace(" ", "_")
        if s in ("1", "one", "starter", "starter_only", "no_backup", "no_extra"):
            parsed = pmin
        elif s in ("2", "two", "backup", "extra", "second"):
            parsed = phi
        elif s in ("3", "three"):
            parsed = phi if pmin >= 2 else 2
        else:
            try:
                parsed = int(s)
            except ValueError:
                parsed = None
    if parsed is None:
        match = _POS_MAX_PREF_MATCH.get(pref) or (pref,)
        n_picks = sum(1 for p in (prefs or []) if p in match)
        parsed = phi if n_picks > pmin else pmin
    return max(pmin, min(int(parsed), phi))


def _parse_max_qb(decision: dict, prefs: list, league_settings: dict) -> int:
    return _parse_pos_max(decision, prefs, league_settings, "QB")


def _llm_position_maxes(decision: dict, prefs: list, league_settings: dict) -> dict:
    return {
        pref: _parse_pos_max(decision, prefs, league_settings, pref)
        for pref in ("QB", "K", "DST")
        if _pos_starter_min(league_settings, pref) > 0
    }


def _finalize_pick_prefs(llm_prefs: list, league_settings: dict) -> list:
    """Use LLM order when present; pad short lists with Flex. Fallback is starters then BA."""
    pick_count = _autopick_pick_count(league_settings)
    prefs = [p for p in (llm_prefs or []) if p]
    if not prefs:
        return _prefs_covering_league(league_settings, [], pick_count)
    while len(prefs) < pick_count:
        prefs.append("FLEX")
    return prefs[:pick_count]


def ask_deepseek_draft_strategy(
    candidates: list,
    top_n: int = 100,
    pick_count: int = 100,
    league_settings_block: str = "",
    league_settings: dict = None,
    session_id: str = None,
) -> tuple:
    """
    Ask DeepSeek for an ordered top-N rankings board, Autopick pick-by-pick
    prefs, and whether extra QB/K/DST beat Flex. Returns
    (ranked_candidates, position_prefs, position_strategy).
    """
    if not candidates:
        raise RuntimeError("No candidates available to rank.")

    pick_count = _autopick_pick_count(league_settings)

    league_settings = league_settings or {}
    required_starters = _required_starter_prefs(league_settings)
    slot_counts = _slot_counts_from_league(league_settings)
    qb_min = _pos_starter_min(league_settings, "QB")
    qb_hi = qb_min + 1
    k_min = _pos_starter_min(league_settings, "K")
    k_hi = k_min + 1 if k_min else 0
    dst_min = _pos_starter_min(league_settings, "DST")
    dst_hi = dst_min + 1 if dst_min else 0
    required_summary = ", ".join(
        f"{n} {p}" for p in _STARTER_EMIT_ORDER if (n := int(slot_counts.get(p) or 0))
    ) or "unknown"
    bench_n = int(slot_counts.get("BENCH") or 0)
    allowed_prefs = ["BEST_AVAILABLE", "QB", "RB", "WR", "TE", "FLEX", "DST", "K"]
    if int(slot_counts.get("OP") or 0):
        allowed_prefs.append("OP")
    allowed_prefs_s = ", ".join(allowed_prefs)

    by_name = {_normalize_name(c["name"]): c for c in candidates}
    compact = [
        {
            "name": c["name"],
            "pos": c["pos"],
            "team": c["team"],
            "prior_ppr": c["prior_ppr"],
            "prior_ppr_season": c.get("prior_ppr_season"),
            "injury_status": c["injury_status"],
            "ir_eligible": bool(c.get("ir_eligible")),
            **({"injury_history": c["injury_history"]} if c.get("injury_history") else {}),
        }
        for c in candidates
    ]

    guidance = load_guidance("system_guidance.md", "data_interpretation_guidance.md", "pre_draft_guidance.md")
    if not (league_settings_block or "").strip():
        raise RuntimeError(
            "League settings are required before ranking — ESPN league info could not be loaded. "
            "Save your League ID / Team ID under ESPN Connection and try again."
        )

    prompt = f"""
{guidance}

DECISION: produce (1) a pre-draft rankings board of exactly {top_n} players (exact take order), (2) Autopick pick-by-pick preferences of exactly {pick_count} slots, and (3) max_qb / max_k / max_dst. YOU choose pick-by-pick order — it does not have to list every starter slot in sequence. Weigh a second QB, second K, or second D/ST against more FLEX (RB/WR/TE). Default to starter-only at those positions and extra Flex unless an extra clearly beats another RB/WR/TE. Use FLEX instead of BEST_AVAILABLE when you want skill players rather than the next QB/K/DST on the board.

DATA YOU WILL RECEIVE:
1. LEAGUE SETTINGS — plain text with Format, Roster, and draft-order lines when present.
2. REQUIRED STARTER SLOTS / BENCH SLOTS — plain text counts from league roster rules.
3. CANDIDATES — JSON array of objects:
   {{"name": string, "pos": string, "team": string, "prior_ppr": number, "prior_ppr_season": int, "injury_status": string, "ir_eligible": boolean, "injury_history"?: object}}
   Copy candidate `name` values exactly. prior_ppr is last completed season production.

REPLY FORMAT — JSON object only, exactly {top_n} rankings, exactly {pick_count} pick_by_pick values from [{allowed_prefs_s}], plus max_qb ({qb_min} or {qb_hi}), max_k ({k_min} or {k_hi}), max_dst ({dst_min} or {dst_hi}):
{{"rankings": [{{"rank": 1, "name": "Player Name", "pos": "RB"}}, {{"rank": 2, "name": "Player Name", "pos": "WR"}}], "pick_by_pick": ["RB", "FLEX", "WR"], "max_qb": {qb_min}, "max_k": {k_min}, "max_dst": {dst_min}}}

---

LEAGUE SETTINGS:
{league_settings_block}

REQUIRED STARTER SLOTS: {required_summary}
BENCH SLOTS: {bench_n}
QB / K / D/ST vs FLEX: starter QB={qb_min}, K={k_min}, D/ST={dst_min}. Set max_qb to {qb_min} (more Flex) or {qb_hi} (backup QB). Set max_k to {k_min} (more Flex) or {k_hi} (extra K). Set max_dst to {dst_min} (more Flex) or {dst_hi} (extra D/ST). Default to starter-only + Flex unless an extra clearly wins.

STRICT RULES:
- Factor in league format (PPR vs standard, roster slots, team count, your pick position).
- In PPR, bump pass-catching RBs/WRs; in standard, lean more rush-heavy RBs.
- Early ranks should supply starter-caliber players; later ranks add depth, then K/DST.
- Include enough QB/RB/WR/TE/FLEX-eligible/DST/K on the board to fill the roster over the draft.
- pick_by_pick is YOUR Autopick round order ({pick_count} values). Do not copy a fixed starter sequence. FLEX is valid and preferred over BEST_AVAILABLE when you want skill-position priority (RB/WR/TE).
- Choose max_qb, max_k, and max_dst. Starter-only ({qb_min}/{k_min}/{dst_min}) means extra Flex; +1 means a second at that position instead of Flex. Match pick_by_pick to those choices. Extra K or D/ST should be rare.
- If your Round 1 pick position is late, favor more positional flexibility / scarcity later on the board.
- Prefer healthy ACTIVE players when value/ceiling is similar.
- You MAY still rank IR-Eligible players when their season-long ceiling is clearly higher
  than the healthy alternatives at that spot — the upside gap must outweigh the injury risk.
  Do not draft injured mid/low-tier depth over healthier peers.
- injury_history is past-season game injury counts (Out / Doubtful / Questionable).
  Chronic missers get a slight discount vs. peers with clean histories;
  do not auto-exclude a healthy player solely for old injuries if ceiling remains elite.
- Put K / DST near the end of the board unless the league forces otherwise.
- Rookies may have prior_ppr = 0; rank them on role/opportunity, not invented stats.

CANDIDATES:
{json.dumps(compact, indent=2)}
"""
    decision = query_local_deepseek(prompt, session_id=session_id, timeout=180)
    raw = decision.get("rankings") or decision.get("players") or decision.get("board") or []
    ranked = []
    seen = set()
    for item in raw:
        if isinstance(item, str):
            name = item
        elif isinstance(item, dict):
            name = item.get("name") or item.get("player") or item.get("recommended_player") or ""
        else:
            continue
        key = _normalize_name(name)
        cand = by_name.get(key)
        if not cand:
            key2 = re.sub(r"\b(jr|sr|ii|iii|iv)\b", "", key).strip()
            cand = by_name.get(key2)
        if not cand or cand["espn_id"] in seen:
            continue
        seen.add(cand["espn_id"])
        ranked.append(cand)

    if len(ranked) < top_n:
        fillers = sorted(
            candidates,
            key=lambda c: (c.get("is_injured", False), -c.get("prior_ppr", 0), c.get("name") or ""),
        )
        for cand in fillers:
            if cand["espn_id"] in seen:
                continue
            ranked.append(cand)
            seen.add(cand["espn_id"])
            if len(ranked) >= top_n:
                break

    if not ranked:
        raise RuntimeError("DeepSeek returned no usable rankings and candidate fill failed.")

    ranked = ranked[:top_n]

    prefs = _finalize_pick_prefs(_prefs_from_llm(decision), league_settings)
    pos_maxes = _llm_position_maxes(decision, prefs, league_settings)
    position_strategy = _position_strategy_from_league(league_settings, maxes=pos_maxes)

    log_system_event(
        "DRAFT_STRATEGY_RANKED",
        f"DeepSeek produced {len(ranked)} rankings and {len(prefs)} Autopick prefs "
        f"(maxes={pos_maxes}, pool={len(candidates)}).",
        {
            "requested": top_n,
            "returned": len(ranked),
            "pick_count": len(prefs),
            "pick_by_pick": prefs,
            "position_maxes": pos_maxes,
            "required_summary": required_summary,
            "bench_slots": bench_n,
        },
        session_id=session_id,
    )
    return ranked, prefs, position_strategy


# Back-compat wrapper
def ask_deepseek_top_rankings(
    candidates: list,
    top_n: int = 100,
    league_settings_block: str = "",
    league_settings: dict = None,
    session_id: str = None,
    pick_count: int = 100,
    **_kwargs,
):
    ranked, _prefs, _limits = ask_deepseek_draft_strategy(
        candidates,
        top_n=top_n,
        pick_count=pick_count or top_n,
        league_settings_block=league_settings_block,
        league_settings=league_settings,
        session_id=session_id,
    )
    return ranked


def write_draft_strategy(
    league_id: str,
    team_id: str,
    player_ids: Iterable[int],
    pick_preferences: Optional[List[str]] = None,
    excluded_player_ids: Optional[Iterable[int]] = None,
    position_strategy: Optional[List[dict]] = None,
    session_id: str = None,
) -> dict:
    """
    POST Pre-Draft Rankings (draftList), optional Autopick pick-by-pick
    roundStrategy, and optional Autopick positionStrategy (min/max) in one write.
    """
    cookies = _cookies(session_id)
    ids = [int(pid) for pid in player_ids]
    prefs = list(pick_preferences or [])
    pos_limits = list(position_strategy or [])
    banned_pos = set()
    url = _team_write_url(league_id, team_id)
    resp = None

    for _attempt in range(8):
        draft_list = [{"playerId": pid} for pid in ids]
        payload = {
            "draftStrategy": {
                "draftList": draft_list,
                "excludedPlayerIds": [int(x) for x in (excluded_player_ids or [])],
            }
        }
        if prefs:
            payload["draftStrategy"]["roundStrategy"] = [
                {
                    "roundId": i,
                    "positionIds": [
                        pid for pid in _round_strategy_position_ids(pref)
                        if pid not in banned_pos
                    ] or [-1],
                    "statId": -1,
                }
                for i, pref in enumerate(prefs)
            ]
        if pos_limits:
            payload["draftStrategy"]["positionStrategy"] = pos_limits

        resp = requests.post(url, headers=WRITE_HEADERS, cookies=cookies, json=payload, timeout=90)
        if resp.status_code < 400:
            break

        bad_pos = _parse_invalid_strategy_position(resp)
        if bad_pos is None and pos_limits:
            logging.warning(
                "ESPN rejected Autopick positionStrategy; retrying without min/max limits."
            )
            log_system_event(
                "DRAFT_STRATEGY_SKIP_POSITION_LIMITS",
                "Skipped Autopick position min/max (ESPN rejected positionStrategy).",
                {"status": resp.status_code, "body": (resp.text or "")[:300]},
                session_id=session_id,
            )
            pos_limits = []
            continue
        if bad_pos is None:
            raise RuntimeError(
                f"ESPN draft strategy write failed ({resp.status_code}): {resp.text[:500]}"
            )
        logging.warning(
            f"ESPN rejected Autopick position {bad_pos}; skipping those slots "
            f"(using BEST_AVAILABLE)."
        )
        log_system_event(
            "DRAFT_STRATEGY_SKIP_INVALID_POS",
            f"Skipped Autopick position {bad_pos} (not a valid ESPN roundStrategy slot).",
            {"position_id": bad_pos},
            session_id=session_id,
        )
        banned_pos.add(bad_pos)
        prefs = [
            "BEST_AVAILABLE"
            if bad_pos in _round_strategy_position_ids(p) and _normalize_pref(p) != "FLEX"
            else p
            for p in prefs
        ]
    else:
        raise RuntimeError(
            f"ESPN draft strategy write failed ({resp.status_code if resp else '?'}): "
            f"{(resp.text[:500] if resp is not None else 'no response')}"
        )

    log_system_event(
        "DRAFT_STRATEGY_SAVED",
        f"Saved draftList ({len(draft_list)})"
        + (f" + roundStrategy ({len(pick_preferences)})" if pick_preferences else "")
        + (f" + positionStrategy ({len(pos_limits)})" if pos_limits else "")
        + f" for league {league_id} team {team_id}",
        {
            "league_id": league_id,
            "team_id": team_id,
            "draft_list_count": len(draft_list),
            "pick_count": len(pick_preferences or []),
            "position_limits": _position_strategy_label(pos_limits),
        },
        session_id=session_id,
    )
    return resp.json()


def write_pre_draft_rankings(
    league_id: str,
    team_id: str,
    player_ids: Iterable[int],
    excluded_player_ids: Optional[Iterable[int]] = None,
    session_id: str = None,
) -> dict:
    """POST Pre-Draft Rankings only (draftList)."""
    return write_draft_strategy(
        league_id,
        team_id,
        player_ids,
        pick_preferences=None,
        excluded_player_ids=excluded_player_ids,
        session_id=session_id,
    )


def setup_draft_strategy(
    league_id: str = None,
    team_id: str = None,
    top_n: int = 100,
    session_id: str = None,
) -> dict:
    """
    Use nflreadpy + DeepSeek to pick `top_n` players (preferring healthy, but
    allowing high-ceiling injured names), then write that ordered list to ESPN
    Edit Pre-Draft Strategy for the given league/team.
    Always pulls live ESPN league settings (format, roster, draft order) first
    so DeepSeek ranks with that league's context.
    """
    settings = resolve_espn_settings(session_id=session_id)
    league_id = str(league_id or settings["league_id"] or "").strip()
    team_id = str(team_id or settings["team_id"] or "").strip()
    if not league_id:
        raise ValueError("league_id is required (pass it or save it in ESPN Connection).")
    if not team_id:
        raise ValueError("team_id is required (pass it or save it in ESPN Connection).")

    # Make sure subsequent ESPN reads use this league/team for the session.
    if str(settings.get("league_id") or "") != league_id or str(settings.get("team_id") or "") != team_id:
        save_espn_settings(league_id=league_id, team_id=team_id, session_id=session_id)

    # Always refresh league info from ESPN before asking the model.
    league_settings = fetch_espn_league_settings(session_id=session_id)
    league_block = "\n\n".join(filter(None, [
        format_league_settings_block(league_settings),
        format_draft_order_block(
            league_settings.get("draft_order", []),
            league_settings.get("draft_type", "SNAKE"),
        ),
    ]))
    if not league_block.strip():
        league_block = get_saved_league_settings_block(session_id=session_id)
    if not league_block.strip():
        raise RuntimeError(
            f"Could not load league settings for leagueId={league_id}. "
            "Check ESPN Connection (league id, team id, cookies) and try again."
        )

    log_system_event(
        "DRAFT_STRATEGY_LEAGUE_CONTEXT",
        f"Loaded league context for draft strategy (league {league_id}, team {team_id})",
        {
            "league_id": league_id,
            "team_id": team_id,
            "league_format": league_settings.get("league_format"),
            "roster_settings": league_settings.get("roster_settings"),
            "draft_type": league_settings.get("draft_type"),
            "your_pick": next(
                (p["pick"] for p in (league_settings.get("draft_order") or []) if p.get("is_you")),
                None,
            ),
        },
        session_id=session_id,
    )

    candidates = build_draft_candidates(session_id=session_id)
    # Autopick rows = roster size (starters + bench). Rankings stay top_n.
    pick_count = _autopick_pick_count(league_settings)
    ranked, pick_prefs, position_strategy = ask_deepseek_draft_strategy(
        candidates,
        top_n=top_n,
        pick_count=pick_count,
        league_settings_block=league_block,
        league_settings=league_settings,
        session_id=session_id,
    )
    espn_ids = [int(p["espn_id"]) for p in ranked]
    result = write_draft_strategy(
        league_id,
        team_id,
        espn_ids,
        pick_preferences=pick_prefs,
        position_strategy=position_strategy,
        session_id=session_id,
    )
    ranked_lines = [
        f"{i + 1}. {p.get('name') or ''} ({p.get('pos') or '?'})"
        for i, p in enumerate(ranked)
    ]
    pick_by_pick_log = []
    for i, pref in enumerate(pick_prefs):
        entry = {"pick": i + 1, "preference": _pref_label(pref)}
        if i < len(ranked):
            p = ranked[i]
            entry.update({
                "board_player": p.get("name"),
                "board_pos": p.get("pos"),
                "espn_id": p.get("espn_id"),
            })
        pick_by_pick_log.append(entry)
    required_starters = _required_starter_prefs(league_settings)
    record_id = log_action(
        week=0,
        action_type="DRAFT_STRATEGY_SETUP",
        starters=ranked_lines,
        bench=[f"{e['pick']}. {e['preference']}" for e in pick_by_pick_log],
        rationale=(
            f"DeepSeek ranked {len(espn_ids)} players; Autopick pick-by-pick "
            f"[{', '.join(_pref_label(p) for p in pick_prefs)}] "
            f"({len(pick_prefs)} prefs); position limits "
            f"[{_position_strategy_label(position_strategy) or 'n/a'}] "
            f"for league {league_id} ({league_settings.get('league_format')})."
        ),
        status="EXECUTED",
        prompt_sent=f"{draft_strategy_url(league_id)}\n\n{league_block}",
        raw_response=json.dumps({
            "count": len(espn_ids),
            "pick_count": len(pick_by_pick_log),
            "required_starters": required_starters,
            "position_maxes": {
                "QB": next((r.get("maximum") for r in position_strategy if r.get("positionId") == 1), None),
                "K": next((r.get("maximum") for r in position_strategy if r.get("positionId") == 5), None),
                "DST": next((r.get("maximum") for r in position_strategy if r.get("positionId") == 16), None),
            },
            "position_limits": position_strategy,
            "rankings": [
                {"rank": i + 1, "name": p["name"], "pos": p["pos"], "espn_id": p["espn_id"]}
                for i, p in enumerate(ranked)
            ],
            "pick_by_pick": pick_by_pick_log,
        }, ensure_ascii=False),
        session_id=session_id,
    )
    return {
        "record_id": record_id,
        "league_id": league_id,
        "team_id": team_id,
        "strategy_url": draft_strategy_url(league_id),
        "league_format": league_settings.get("league_format"),
        "roster_settings": league_settings.get("roster_settings"),
        "draft_type": league_settings.get("draft_type"),
        "top_n": top_n,
        "pick_count": pick_count,
        "pick_by_pick": pick_by_pick_log,
        "position_limits": position_strategy,
        "wrote_count": len(espn_ids),
        "top_players": [
            {"rank": i + 1, "name": p["name"], "pos": p["pos"], "espn_id": p["espn_id"],
             "injury_status": p.get("injury_status"),
             **({"injury_history": p["injury_history"]} if p.get("injury_history") else {})}
            for i, p in enumerate(ranked)
        ],
        "espn_response_abbrev": (result or {}).get("abbrev"),
    }
