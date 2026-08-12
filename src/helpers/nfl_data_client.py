"""
NFL Player Stats Client
Fetches player weekly stats, multi-season history, injury reports, and rosters
from the open nflverse dataset via nflreadpy, instead of relying on ESPN for
player performance data.

nflreadpy returns Polars DataFrames; this module converts everything to pandas
before caching/matching so the rest of the app can keep using pandas.

ESPN is still used elsewhere (espn_client.py) to read your actual fantasy team's
roster/starter-bench slots, since that is league-specific data only ESPN has.
This module supplies the real stat lines and injury status used to enrich that
roster before it's sent to DeepSeek.
"""

import os
import logging
import datetime
import pandas as pd
import nflreadpy as nfl

from src.helpers.db_manager import log_system_event

_weekly_cache = {}
_injury_cache = {}
_roster_cache = {}
_seasonal_cache = {}
_player_name_map = None

# Completed seasons never change, so they're cached to disk as parquet files
# (one per dataset/season) to avoid re-downloading them on every run. The
# in-progress current-year season is deliberately never disk-cached.
BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DISK_CACHE_DIR = os.path.join(BASE_DIR, "data", "nfl_cache")


def _to_pandas(frame) -> pd.DataFrame:
    """Convert nflreadpy Polars output to pandas (no-op if already pandas)."""
    if frame is None:
        return pd.DataFrame()
    if isinstance(frame, pd.DataFrame):
        return frame
    return frame.to_pandas()


def _current_nfl_season() -> int:
    """Prefer nflreadpy's season helper; fall back to calendar year."""
    try:
        return int(nfl.get_current_season())
    except Exception:
        return datetime.datetime.now().year


def fantasy_espn_season() -> int:
    """ESPN fantasy league season (env override, else calendar year)."""
    return int(os.getenv("ESPN_SEASON", datetime.datetime.now().year))


def draft_stats_season(fantasy_season: int = None) -> int:
    """
    NFL stats season to use for pre-draft strategy enrichment.

    Fantasy drafts for year N happen before (or as) the NFL regular season starts,
    so year-N game logs / seasonal totals are not available yet. Use the last
    completed season (N-1) for production history. Example: 2026 fantasy draft
    → 2025 (and earlier) stats.
    """
    fantasy_season = int(fantasy_season or fantasy_espn_season())
    return fantasy_season - 1


def _is_immutable_season(season: int) -> bool:
    """A season stops changing once it's older than the current NFL season."""
    return season < _current_nfl_season()


def _disk_cache_path(cache_key: str, season: int) -> str:
    return os.path.join(DISK_CACHE_DIR, f"{cache_key}_{season}.parquet")


def _load_weekly_stats(seasons: list) -> pd.DataFrame:
    return _to_pandas(nfl.load_player_stats(seasons, summary_level="week"))


def _load_seasonal_stats(seasons: list) -> pd.DataFrame:
    # "reg" = regular-season aggregates (nfl_data_py's import_seasonal_data equivalent)
    return _to_pandas(nfl.load_player_stats(seasons, summary_level="reg"))


def _load_injuries(seasons: list) -> pd.DataFrame:
    return _to_pandas(nfl.load_injuries(seasons))


def _load_rosters(seasons: list) -> pd.DataFrame:
    return _to_pandas(nfl.load_rosters(seasons))


def _fetch_with_fallback(fetch_fn, season: int, cache: dict, label: str, cache_key: str,
                          min_season: int = 1999, session_id: str = None):
    """
    Try to fetch nflverse data for `season`, stepping back a year at a time if the
    dataset for that season hasn't been published yet (common in the off-season
    before the current year's data drops). Caches per resolved season in memory
    for this process, and on disk for completed/immutable seasons so future
    runs don't re-download data that will never change.
    """
    year = season
    while year >= min_season:
        if year in cache:
            log_system_event("NFL_DATA_CACHE_HIT", f"Reused in-memory {label} for {year} (0 network requests)", {"cache_key": cache_key, "season": year}, session_id=session_id)
            return cache[year], year

        disk_path = _disk_cache_path(cache_key, year)
        if os.path.exists(disk_path):
            df = pd.read_parquet(disk_path)
            cache[year] = df
            log_system_event("NFL_DATA_DISK_CACHE_HIT", f"Loaded {label} for {year} from local disk cache (0 network requests)", {"cache_key": cache_key, "season": year, "path": disk_path}, session_id=session_id)
            return df, year

        try:
            df = fetch_fn([year])
            if not isinstance(df, pd.DataFrame):
                df = _to_pandas(df)
            # Empty frames mean "not published yet" — step back (common for the
            # upcoming fantasy season before kickoff).
            if df is None or len(df) == 0:
                raise RuntimeError(f"empty {label} frame for {year}")
            cache[year] = df
            disk_cached = False
            if _is_immutable_season(year):
                try:
                    os.makedirs(DISK_CACHE_DIR, exist_ok=True)
                    df.to_parquet(disk_path)
                    disk_cached = True
                except Exception as e:
                    logging.warning(f"nflreadpy: could not write disk cache for {cache_key} {year}: {e}")
            if year != season:
                logging.info(f"nflreadpy: {label} for {season} unavailable, using {year} instead.")
            log_system_event(
                "NFL_DATA_DOWNLOADED",
                f"Downloaded {label} for {year} from nflverse" + (f" (requested {season})" if year != season else "") + (", cached to disk" if disk_cached else ""),
                {"cache_key": cache_key, "requested_season": season, "resolved_season": year, "disk_cached": disk_cached, "rows": len(df)},
                session_id=session_id
            )
            return df, year
        except Exception as e:
            logging.warning(f"nflreadpy: {label} for {year} unavailable ({e}), trying {year - 1}...")
            year -= 1
    log_system_event("NFL_DATA_FETCH_ERROR", f"No nflreadpy {label} available back to {min_season}", {"cache_key": cache_key, "requested_season": season}, session_id=session_id)
    raise RuntimeError(f"No nflreadpy {label} available back to {min_season}")


def get_weekly_stats(season: int, week: int = None, session_id: str = None):
    """Return weekly player stats, falling back to the most recent published season."""
    df, resolved_season = _fetch_with_fallback(_load_weekly_stats, season, _weekly_cache, "weekly stats", "weekly_nflreadpy", session_id=session_id)
    if week:
        df = df[df["week"] == week]
    return df, resolved_season


def get_injuries(season: int, week: int = None, session_id: str = None):
    """Return injury reports, falling back to the most recent published season."""
    df, resolved_season = _fetch_with_fallback(_load_injuries, season, _injury_cache, "injury reports", "injuries_nflreadpy", session_id=session_id)
    if week:
        df = df[df["week"] == week]
    return df, resolved_season


def get_injury_history_by_player(
    seasons: list,
    gsis_ids: set = None,
    session_id: str = None,
) -> dict:
    """
    Aggregate nflverse injury reports across seasons into a compact per-player
    history for LLM context. Past/immutable seasons are disk-cached via get_injuries.

    Returns: {gsis_id: {"summary": str, "seasons": [{season, out, doubtful, questionable, injuries}]}}
    """
    wanted = set(gsis_ids) if gsis_ids else None
    by_player = {}

    for season in seasons:
        try:
            df, resolved = get_injuries(int(season), session_id=session_id)
        except Exception as e:
            logging.warning(f"Could not load injuries for season {season}: {e}")
            continue
        if df is None or len(df) == 0 or "gsis_id" not in df.columns:
            continue

        work = df.copy()
        if wanted is not None:
            work = work[work["gsis_id"].isin(wanted)]
        if len(work) == 0:
            continue

        # Prefer game report status; ignore pure rest / non-injury practice notes.
        status_col = "report_status" if "report_status" in work.columns else None
        injury_col = "report_primary_injury" if "report_primary_injury" in work.columns else None
        week_col = "week" if "week" in work.columns else None
        if not status_col:
            continue

        for gsis, group in work.groupby("gsis_id"):
            if gsis is None or (isinstance(gsis, float) and pd.isna(gsis)):
                continue
            statuses = group[status_col].dropna().astype(str).str.strip().str.lower()
            out_n = int((statuses == "out").sum())
            doubtful_n = int((statuses == "doubtful").sum())
            q_n = int((statuses == "questionable").sum())
            if out_n + doubtful_n + q_n == 0:
                continue

            injuries = []
            if injury_col:
                injuries = (
                    group[injury_col]
                    .dropna()
                    .astype(str)
                    .str.strip()
                    .replace("", pd.NA)
                    .dropna()
                    .value_counts()
                    .head(3)
                    .index.tolist()
                )

            weeks_out = []
            if week_col and out_n:
                out_rows = group[group[status_col].astype(str).str.strip().str.lower() == "out"]
                week_vals = []
                for w in out_rows[week_col].dropna().tolist():
                    try:
                        week_vals.append(int(float(w)))
                    except (TypeError, ValueError):
                        continue
                weeks_out = sorted(set(week_vals))

            entry = by_player.setdefault(gsis, {"seasons": [], "summary": ""})
            entry["seasons"].append({
                "season": int(resolved),
                "out": out_n,
                "doubtful": doubtful_n,
                "questionable": q_n,
                "injuries": injuries,
                "out_weeks": weeks_out[:8],
            })

    for gsis, entry in by_player.items():
        entry["seasons"].sort(key=lambda s: s["season"], reverse=True)
        bits = []
        for s in entry["seasons"]:
            parts = []
            if s["out"]:
                parts.append(f"{s['out']} Out")
            if s["doubtful"]:
                parts.append(f"{s['doubtful']} Doubtful")
            if s["questionable"]:
                parts.append(f"{s['questionable']} Q")
            inj = f" ({', '.join(s['injuries'][:2])})" if s.get("injuries") else ""
            bits.append(f"{s['season']}: {', '.join(parts)}{inj}")
        entry["summary"] = "; ".join(bits)

    return by_player


def get_seasonal_rosters(season: int, session_id: str = None):
    """Return seasonal rosters, falling back to the most recent published season."""
    df, resolved_season = _fetch_with_fallback(_load_rosters, season, _roster_cache, "seasonal rosters", "rosters_nflreadpy", session_id=session_id)
    return df, resolved_season


def _get_player_name_map():
    """gsis_id -> display_name lookup, used to attach names to seasonal data
    when player_display_name isn't already present."""
    global _player_name_map
    if _player_name_map is None:
        players_df = _to_pandas(nfl.load_players())
        _player_name_map = dict(zip(players_df["gsis_id"], players_df["display_name"]))
    return _player_name_map


_espn_id_to_gsis = None
_ID_CROSSWALK_CACHE_KEY = "ids_crosswalk_nflreadpy"


def _id_crosswalk_disk_path() -> str:
    return os.path.join(DISK_CACHE_DIR, f"{_ID_CROSSWALK_CACHE_KEY}.parquet")


def _crosswalk_dict_from_df(ids_df) -> dict:
    valid = ids_df.dropna(subset=["espn_id", "gsis_id"])
    out = {}
    for row in valid.itertuples():
        try:
            out[str(int(float(row.espn_id)))] = row.gsis_id
        except (TypeError, ValueError):
            continue
    return out


def refresh_espn_id_crosswalk(session_id: str = None) -> dict:
    """
    Force a fresh download of the ESPN-id/gsis-id crosswalk from nflverse and
    persist it to disk. Called once per run by the draft/lineup/trade
    workflows (see their run_*_workflow functions) so the table stays
    reasonably current — NOT called by ad-hoc chat lookups, which only ever
    read whatever's already persisted via get_espn_id_crosswalk() below.
    """
    global _espn_id_to_gsis
    try:
        ids_df = _to_pandas(nfl.load_ff_playerids())
        keep = ids_df.dropna(subset=["espn_id", "gsis_id"])[["espn_id", "gsis_id", "name"]]
        os.makedirs(DISK_CACHE_DIR, exist_ok=True)
        keep.to_parquet(_id_crosswalk_disk_path())
        log_system_event(
            "NFL_DATA_DOWNLOADED",
            f"Refreshed ESPN-id/gsis-id crosswalk from nflverse ({len(keep)} players), cached to disk",
            {"cache_key": _ID_CROSSWALK_CACHE_KEY, "rows": len(keep)},
            session_id=session_id
        )
        _espn_id_to_gsis = _crosswalk_dict_from_df(keep)
        return _espn_id_to_gsis
    except Exception as e:
        logging.warning(f"nflreadpy: could not refresh id crosswalk: {e}")
        log_system_event("NFL_DATA_FETCH_ERROR", f"Could not refresh id crosswalk: {e}", {"cache_key": _ID_CROSSWALK_CACHE_KEY}, session_id=session_id)
        return _espn_id_to_gsis or {}


def get_espn_id_to_name(session_id: str = None) -> dict:
    """espn_id (str) -> display name from the persisted nflverse id crosswalk."""
    get_espn_id_crosswalk(session_id=session_id)  # ensure disk/memory warm
    disk_path = _id_crosswalk_disk_path()
    if not os.path.exists(disk_path):
        return {}
    try:
        keep = pd.read_parquet(disk_path)
    except Exception:
        return {}
    out = {}
    for row in keep.itertuples():
        try:
            eid = str(int(float(row.espn_id)))
        except Exception:
            continue
        name = getattr(row, "name", None)
        if name and not (isinstance(name, float) and pd.isna(name)):
            out[eid] = str(name)
    return out


def get_espn_id_crosswalk(session_id: str = None) -> dict:
    """
    espn_id (str) -> gsis_id, so ESPN roster/draft players can be matched to
    nflverse stat rows by a stable player ID instead of by name. Name matching
    alone can't tell two different real players with the same name apart (the
    NFL has real collisions, e.g. multiple "Josh Williams"/"Kyle Williams"s) —
    see _match_rows(), which is what actually uses this.

    Reuses the persisted table (in-memory, then disk) without hitting the
    network — only refresh_espn_id_crosswalk() (called from the draft/lineup/
    trade workflows) actually re-downloads it. If nothing has been persisted
    yet at all (very first run), this bootstraps one so lookups still work.
    """
    global _espn_id_to_gsis
    if _espn_id_to_gsis is not None:
        return _espn_id_to_gsis

    disk_path = _id_crosswalk_disk_path()
    if os.path.exists(disk_path):
        keep = pd.read_parquet(disk_path)
        log_system_event(
            "NFL_DATA_DISK_CACHE_HIT",
            f"Loaded ESPN-id/gsis-id crosswalk from local disk cache ({len(keep)} players, 0 network requests)",
            {"cache_key": _ID_CROSSWALK_CACHE_KEY},
            session_id=session_id
        )
        _espn_id_to_gsis = _crosswalk_dict_from_df(keep)
        return _espn_id_to_gsis

    logging.info("nflreadpy: no persisted id crosswalk yet, bootstrapping one now.")
    return refresh_espn_id_crosswalk(session_id=session_id)


def _match_rows(df, id_col: str, name_col: str, gsis_id: str, name: str, session_id: str = None):
    """
    Match a player's rows in a stat/injury dataframe. Prefers an exact gsis_id
    match, which is unambiguous. Falls back to case-insensitive name matching
    only when no id is available (e.g. players scraped from the ESPN draft
    board's HTML, or names typed into chat) — and logs a warning if that name
    match is ambiguous (multiple distinct real players share the name in this
    dataset), since the result may then be wrong or blended across players.
    """
    if gsis_id and id_col in df.columns:
        id_matches = df[df[id_col] == gsis_id]
        if not id_matches.empty:
            return id_matches

    if not name:
        return df.iloc[0:0]

    if name_col not in df.columns:
        return df.iloc[0:0]

    name_series = df[name_col].fillna("").astype(str)
    name_matches = df[name_series.str.lower() == name.lower()]
    if id_col in df.columns and not name_matches.empty:
        distinct_ids = name_matches[id_col].nunique()
        if distinct_ids > 1:
            logging.warning(f"nflreadpy: name match for '{name}' is ambiguous ({distinct_ids} distinct players share this name) — result may be wrong or blended.")
            log_system_event(
                "NFL_DATA_AMBIGUOUS_NAME",
                f"'{name}' matched {distinct_ids} distinct players by name alone (no player ID available) — result may be inaccurate.",
                {"name": name, "distinct_ids": int(distinct_ids)},
                session_id=session_id
            )
    return name_matches


def get_seasonal_stats(season: int, session_id: str = None):
    """
    Return season-to-date aggregate stats (totals/efficiency metrics across all
    games played so far this season), falling back to the most recent published
    season. Ensures a player_display_name column exists for name matching.
    """
    df, resolved_season = _fetch_with_fallback(_load_seasonal_stats, season, _seasonal_cache, "seasonal stats", "seasonal_nflreadpy", session_id=session_id)
    if "player_display_name" not in df.columns:
        name_map = _get_player_name_map()
        df = df.copy()
        id_col = "player_id" if "player_id" in df.columns else "gsis_id"
        df["player_display_name"] = df[id_col].map(name_map) if id_col in df.columns else ""
    df = df.copy()
    df["player_display_name"] = df["player_display_name"].fillna("")
    return df, resolved_season


def get_seasonal_stats_multi(season: int, num_seasons: int = 3, session_id: str = None):
    """
    Return season-to-date stats for the `num_seasons` most recent published
    seasons as one combined DataFrame (each row tagged with its `season`), plus
    the list of seasons actually included. The most recent season resolves the
    same way get_seasonal_stats() does; additional prior seasons are always
    fully completed, so they're always eligible for the disk cache.
    """
    latest_df, latest_season = get_seasonal_stats(season, session_id=session_id)
    frames = [latest_df]
    seasons_included = [latest_season]

    year = latest_season - 1
    while len(seasons_included) < num_seasons and year >= 1999:
        try:
            df, resolved = get_seasonal_stats(year, session_id=session_id)
        except Exception as e:
            logging.warning(f"nflreadpy: could not fetch additional season {year}: {e}")
            break
        if resolved in seasons_included:
            break
        frames.append(df)
        seasons_included.append(resolved)
        year = resolved - 1

    combined = pd.concat(frames, ignore_index=True)
    return combined, seasons_included


def _latest_stat_line(df, id_col: str, name_col: str, gsis_id: str, name: str, session_id: str = None) -> dict:
    """Most recent row for a player from a per-week dataset (weekly stats)."""
    matches = _match_rows(df, id_col, name_col, gsis_id, name, session_id=session_id)
    if matches.empty:
        return {}
    return matches.sort_values("week").iloc[-1].to_dict()


# Output key -> nflreadpy seasonal column. Share metrics that existed in
# nfl_data_py (tgt_sh, dom, etc.) are mostly absent from the new stats files;
# missing columns just resolve to None via row.get().
_SEASON_STAT_COLUMN_MAP = {
    "season": "season",
    "games": "games",
    "fantasy_points_ppr": "fantasy_points_ppr",
    "passing_yards": "passing_yards",
    "passing_tds": "passing_tds",
    "interceptions": "interceptions",
    "rushing_yards": "rushing_yards",
    "rushing_tds": "rushing_tds",
    "receptions": "receptions",
    "targets": "targets",
    "receiving_yards": "receiving_yards",
    "receiving_tds": "receiving_tds",
    "tgt_sh": "tgt_sh",
    "ay_sh": "ay_sh",
    "yac_sh": "yac_sh",
    "wopr": "wopr",
    "ry_sh": "ry_sh",
    "rtd_sh": "rtd_sh",
    "rfd_sh": "rfd_sh",
    "rtdfd_sh": "rtdfd_sh",
    "dom": "dom",
    "w8dom": "w8dom",
    "yptmpa": "yptmpa",
    "ppr_sh": "ppr_sh",
}


def _season_stat_lines(df, gsis_id: str, name: str, session_id: str = None) -> list:
    """All season-to-date rows (one per season) for a player, oldest season first."""
    matches = _match_rows(df, "player_id", "player_display_name", gsis_id, name, session_id=session_id)
    if matches.empty:
        return []

    lines = []
    for row in matches.sort_values("season").to_dict("records"):
        line = {out_key: row.get(src_col) for out_key, src_col in _SEASON_STAT_COLUMN_MAP.items()}
        line["epa"] = row.get("passing_epa") or row.get("rushing_epa") or row.get("receiving_epa")
        lines.append(line)
    return lines


def enrich_players_with_stats(
    players: list,
    season: int,
    week: int = None,
    season_history: int = 3,
    session_id: str = None,
    for_draft: bool = False,
) -> list:
    """
    Given a list of {"name": ..., "pos": ..., "espn_id"/"gsis_id": (optional)}
    dicts (e.g. from an ESPN roster or draft board), attach real weekly (most
    recent game), multi-season history (up to `season_history` seasons), and
    injury status pulled from nflreadpy.

    Matching prefers a player ID (gsis_id directly, or espn_id resolved to
    gsis_id via nflverse's id crosswalk) over name matching, since name alone
    can't distinguish two real players who happen to share a name — see
    _match_rows(). Each enriched player gets a "matched_by": "id"/"name"/"none"
    field so callers (including the LLM) can see how confident that match is.
    Players with no name at all are returned unchanged.

    When for_draft=True, `season` should be the last completed NFL season
    (see draft_stats_season()). Prior-season nflverse injury reports are NOT
    treated as current injury_status (use ESPN IR-Eligible for that). Rookies
    will have empty season history until they play.
    """
    try:
        weekly_df, weekly_season = get_weekly_stats(season, week, session_id=session_id)
        seasonal_df, seasons_included = get_seasonal_stats_multi(season, num_seasons=season_history, session_id=session_id)
        injuries_df, injury_season = (pd.DataFrame(), None)
        if not for_draft:
            injuries_df, injury_season = get_injuries(season, week, session_id=session_id)
    except Exception as e:
        logging.warning(f"nflreadpy fetch failed, returning players without stat enrichment: {e}")
        return players

    stats_note = None
    if for_draft:
        fantasy = fantasy_espn_season()
        stats_note = (
            f"Using completed-season nflverse stats ({', '.join(str(s) for s in seasons_included)}); "
            f"{fantasy} regular-season games have not been played yet."
        )

    enriched = []
    for player in players:
        name = player.get("name", "")
        if not name:
            enriched.append(player)
            continue

        gsis_id = player.get("gsis_id")
        espn_id = player.get("espn_id")
        if not gsis_id and espn_id:
            gsis_id = get_espn_id_crosswalk(session_id=session_id).get(str(espn_id))
        matched_by = "id" if gsis_id else "name"

        weekly_line = _latest_stat_line(weekly_df, "player_id", "player_display_name", gsis_id, name, session_id=session_id)
        season_lines = _season_stat_lines(seasonal_df, gsis_id, name, session_id=session_id)

        if for_draft:
            # Do not present last year's nflverse injury report as current status.
            injury_status = player.get("injury_status") or "UNKNOWN"
        else:
            injury_matches = _match_rows(injuries_df, "gsis_id", "full_name", gsis_id, name, session_id=session_id)
            injury_status = injury_matches.sort_values("week").iloc[-1]["report_status"] if not injury_matches.empty else "ACTIVE"

        has_stats = bool(weekly_line or season_lines)
        row = {
            **player,
            "matched_by": matched_by if (has_stats or (not for_draft and injury_status != "ACTIVE")) else "none",
            "recent_stats": {
                "season": weekly_season,
                "week": weekly_line.get("week"),
                "fantasy_points_ppr": weekly_line.get("fantasy_points_ppr"),
                "passing_yards": weekly_line.get("passing_yards"),
                "passing_tds": weekly_line.get("passing_tds"),
                "rushing_yards": weekly_line.get("rushing_yards"),
                "rushing_tds": weekly_line.get("rushing_tds"),
                "receiving_yards": weekly_line.get("receiving_yards"),
                "receiving_tds": weekly_line.get("receiving_tds"),
                "targets": weekly_line.get("targets"),
            } if weekly_line else None,
            "season_stats_by_year": season_lines,
            "injury_status": injury_status,
        }
        if for_draft:
            row["stats_context"] = stats_note
            row["stats_seasons"] = list(seasons_included)
        enriched.append(row)

    return enriched
