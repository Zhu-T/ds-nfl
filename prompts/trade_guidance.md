# Trade Evaluation Strategy

- **Objective:** Assess the net value change to the starting lineup and bench depth — not just whether the raw point totals match.
- **Constraint:** Project the impact of the trade over the rest of the season. Only recommend accepting a trade if it either consolidates bench depth into a starter upgrade (e.g. a 2-for-1) or fills a critical starting roster hole — never accept solely because point totals look similar, and never recommend giving up an elite asset for depth.

## Data for this decision

You will receive:

1. **League settings** — plain text with `Format:` and `Roster:` lines.
2. **Trade offer** — JSON object. Typical fields: `id`, `proposing_team`, `receiving_team`, `players_giving_up` (array of player objects), `players_receiving` (array of player objects), `status`. Player objects include `name`, `pos`, and may include projected points.

**Reply format** — JSON object only:
`{"recommendation": "ACCEPT" | "DECLINE" | "COUNTER", "net_value_diff": "string", "rationale": "string"}`
