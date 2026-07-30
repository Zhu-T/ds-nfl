"""
NFL Player Stats Client
Fetches player weekly stats, injury reports, and rosters from the open nflverse
dataset via nfl_data_py, instead of relying on ESPN for player performance data.

ESPN is still used elsewhere (espn_client.py) to read your actual fantasy team's
roster/starter-bench slots, since that is league-specific data only ESPN has.
This module supplies the real stat lines and injury status used to enrich that
roster before it's sent to DeepSeek.
"""

import logging
import nfl_data_py as nfl

_weekly_cache = {}
_injury_cache = {}
_roster_cache = {}


def _fetch_with_fallback(fetch_fn, season: int, cache: dict, label: str, min_season: int = 1999):
    """
    Try to fetch nflverse data for `season`, stepping back a year at a time if the
    dataset for that season hasn't been published yet (common in the off-season
    before the current year's data drops). Caches per resolved season.
    """
    year = season
    while year >= min_season:
        if year in cache:
            return cache[year], year
        try:
            df = fetch_fn([year])
            cache[year] = df
            if year != season:
                logging.info(f"nfl_data_py: {label} for {season} unavailable, using {year} instead.")
            return df, year
        except Exception as e:
            logging.warning(f"nfl_data_py: {label} for {year} unavailable ({e}), trying {year - 1}...")
            year -= 1
    raise RuntimeError(f"No nfl_data_py {label} available back to {min_season}")


def get_weekly_stats(season: int, week: int = None):
    """Return weekly player stats, falling back to the most recent published season."""
    df, resolved_season = _fetch_with_fallback(nfl.import_weekly_data, season, _weekly_cache, "weekly stats")
    if week:
        df = df[df["week"] == week]
    return df, resolved_season


def get_injuries(season: int, week: int = None):
    """Return injury reports, falling back to the most recent published season."""
    df, resolved_season = _fetch_with_fallback(nfl.import_injuries, season, _injury_cache, "injury reports")
    if week:
        df = df[df["week"] == week]
    return df, resolved_season


def get_seasonal_rosters(season: int):
    """Return seasonal rosters, falling back to the most recent published season."""
    df, resolved_season = _fetch_with_fallback(nfl.import_seasonal_rosters, season, _roster_cache, "seasonal rosters")
    return df, resolved_season


def _latest_stat_line(df, name_col: str, name: str) -> dict:
    matches = df[df[name_col].str.lower() == name.lower()]
    if matches.empty:
        return {}
    return matches.sort_values("week").iloc[-1].to_dict()


def enrich_players_with_stats(players: list, season: int, week: int = None) -> list:
    """
    Given a list of {"name": ..., "pos": ...} dicts (e.g. from an ESPN roster or
    draft board), attach real recent stat lines and injury status pulled from
    nfl_data_py. Players that can't be matched by name are returned unchanged.
    """
    try:
        weekly_df, _ = get_weekly_stats(season, week)
        injuries_df, _ = get_injuries(season, week)
    except Exception as e:
        logging.warning(f"nfl_data_py fetch failed, returning players without stat enrichment: {e}")
        return players

    enriched = []
    for player in players:
        name = player.get("name", "")
        if not name:
            enriched.append(player)
            continue

        stat_line = _latest_stat_line(weekly_df, "player_display_name", name)
        injury_matches = injuries_df[injuries_df["full_name"].str.lower() == name.lower()]
        injury_status = injury_matches.sort_values("week").iloc[-1]["report_status"] if not injury_matches.empty else "ACTIVE"

        enriched.append({
            **player,
            "recent_stats": {
                "week": stat_line.get("week"),
                "fantasy_points_ppr": stat_line.get("fantasy_points_ppr"),
                "passing_yards": stat_line.get("passing_yards"),
                "passing_tds": stat_line.get("passing_tds"),
                "rushing_yards": stat_line.get("rushing_yards"),
                "rushing_tds": stat_line.get("rushing_tds"),
                "receiving_yards": stat_line.get("receiving_yards"),
                "receiving_tds": stat_line.get("receiving_tds"),
                "targets": stat_line.get("targets"),
            } if stat_line else None,
            "injury_status": injury_status,
        })

    return enriched
