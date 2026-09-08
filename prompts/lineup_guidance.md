# Lineup Selection Strategy

- **Objective:** Maximize the projected point total and win probability for the current week's matchup.
- **Only this roster:** Suggest starters and bench using only the players listed in the prompt. Copy those names exactly. Do not name anyone else, including famous players, waiver targets, or example placeholders. IR players cannot start.
- **Already starting:** Players marked ACTIVE are already in the lineup. Do not recommend a change for them unless you are benching them. Only bench players who should come in need a start.

## Data for this decision

You will receive:

1. **League settings** — plain text with `Format:` and `Roster:` lines.
2. **Allowed players** — the only names that may appear in `starters` or `bench`. Copy them exactly. IR players cannot start and are not allowed.

**Reply format** — JSON object only. `starters` and `bench` are names from the allowed list, nothing else:
`{"starters": ["Exact Name From Roster"], "bench": ["Exact Name From Roster"], "rationale": "string"}`
