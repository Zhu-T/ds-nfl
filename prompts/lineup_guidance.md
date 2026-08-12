# Lineup Selection Strategy

- **Objective:** Maximize the projected point total and win probability for the current week's matchup.
- **Constraint:** If the matchup projects as a significant loss, prioritize high-variance/high-ceiling (boom-or-bust) players who give a path to an upset. If projected to win comfortably, prioritize high-floor players with safe, guaranteed volume to protect the win.

## Data for this decision

You will receive:

1. **League settings** — plain text with `Format:` and `Roster:` lines.
2. **Roster data** — JSON object: `week` (int), `team_id`, `players` (array). Each player typically includes `name`, `pos`, `status` (`ACTIVE` / `BENCH` / `IR`), `lineup_slot`, `recent_stats` (latest game object or null), `season_stats_by_year` (array), `injury_status` (string).

**Reply format** — JSON object only:
`{"starters": ["Player A"], "bench": ["Player B"], "rationale": "string"}`
