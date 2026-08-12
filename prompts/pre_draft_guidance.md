# Pre-Draft Strategy

- **Objective:** Maximize overall roster value while ensuring starting positional requirements are met before drafting depth (excluding K/DST).
- Balance positional scarcity, starting roster requirements, and player upside against baseline risk.

## Core Directives

### 1. Value Over Replacement Player (VORP) & Scarcity

- Evaluate the drop-off in projected value between the best player available now and the best player likely to be available at the next pick.
- Do not reach for a positional need if the value drop-off is significantly larger elsewhere on the board.
- **Positional scarcity:** Explicitly weigh scarcity. A baseline starting RB is generally scarcer than a baseline starting QB. Default to the scarcer position when projected value drop-offs are mathematically tied.

### 2. Preseason Stats & Player Profiling

- Fantasy drafts happen before the current NFL regular season. Rely on completed prior-season production (`prior_ppr` / `season_stats_by_year` / `recent_stats` tagged with their season). There are no current-year game logs yet.
- **Rookies:** Often have no prior NFL stats. Rank them on expected role (`depth_chart_status` when present), not invented numbers. Do not treat missing current-year stats as a data error.
- **Age curves:** When `age` is present, slightly discount RBs over 27 and WRs over 30 versus younger players with similar `prior_ppr`.
- **Bye weeks:** When ranking backup depth for later rounds, if `bye_week` is present, heavily penalize players who share a bye with the highest-ranked starter at their position to avoid lineup voids.

### 3. Injury & Upside Logic

- Current injury labels come from the **IR-Eligible** list (Out / IR). Prefer healthy players when value is similar.
- You MAY rank an IR-Eligible player ahead of healthier options when their season-long ceiling is clearly higher (the upside gap outweighs early-season missed games).
- Still lean healthy for mid/low-tier interchangeable depth.
- If `injury_history` is present, discount chronic missers slightly versus peers with clean histories, but do not auto-exclude a currently healthy elite player solely for old injuries.

### 4. Roster Construction

- Rankings must be the **exact order** players should be taken.
- Early ranks should supply starter-caliber players for every league-required slot.
- Later ranks add depth, then K/DST. A backup TE is acceptable only if they mathematically outrank remaining RB/WR dart throws.

### 5. Autopick pick-by-pick

- You choose the Autopick pick-by-pick preference for every roster slot (starters + bench). This is separate from the rankings board.
- You do **not** have to list every starting position in a fixed order (e.g. you may take WR before RB, or wait on QB).
- Allowed values: `BEST_AVAILABLE`, `QB`, `RB`, `WR`, `TE`, `FLEX`, `DST`, `K` (and `OP` if the league has Superflex).
- Use `FLEX` instead of `BEST_AVAILABLE` when you want Autopick to take RB/WR/TE (e.g. extra RBs or TEs early) rather than the next QB/K/DST on the board.
- Use a specific position when you want that round locked (late K/DST is typical).

### 6. Extra QB / K / D/ST vs Flex

- Explicitly weigh a **second QB**, **second K**, or **second D/ST** against **more Flex** (RB/WR/TE) depth. Those extras usually lose to Flex; only take them when the value gap is clear.
- **QB:** In a 1-QB league, default to one QB and extra Flex unless a backup QB clearly beats another RB/WR/TE. Superflex already needs two QBs; then decide whether a third beats Flex.
- **K and D/ST:** Default to **one** of each (last rounds) and extra Flex. A second kicker or defense is rarely worth a roster slot vs RB/WR/TE; only do it if bye-week or streaming value clearly wins.
- Set `max_qb`, `max_k`, and `max_dst` to match. If you want only one: include that position once in pick-by-pick and use `FLEX` for remaining skill rounds. If you want two: include the second pick (usually late) and set that max to 2.
- Autopick position maxes follow those fields.

### 7. Pick slot

Rankings and Autopick order should follow the saved round-1 pick slot (early / middle / late). 12-team bands are slots 1–4 / 5–8 / 9–12; other sizes use the same thirds.

- **Early (1–4):** Rank an undisputed high-ceiling RB or WR first. Then a long run of the opposite position (Hero RB/WR) through the next several ranks. Do not reach at what will be the round 2/3 turn — the wait to round 4 is very long. Hero RB: one elite RB, then WRs, cheap RBs later; take an elite QB **or** elite TE early-mid, not both.
- **Middle (5–8):** Rank best player available at the top. Stay flexible (do not force Zero RB). If elite QB/TE value appears in the round 3–4 range after a skill-position run, it can outrank a lesser RB/WR. Prefer high-floor RB/WR for balanced depth. Robust RB (two early workhorse RBs): wait on QB/TE and catch up on WR in the middle ranks.
- **Late & the turn (9–12):** Rank in complementary pairs (two of a premium tier together) because snake picks are back-to-back then a long wait. Ceiling over safety. Autopick may open Hyper-Fragile (three elite RBs immediately, then heavy WR, punt QB/TE late) or Zero RB (no RB in the first five, lock elite TE and a top QB) — pick one; do not mix.

## Data for this decision

You will receive:

1. **League settings** — plain text with `Format:`, `Roster:`, and draft-order lines when present.
2. **Required starter slots / bench slots** — plain text counts from league roster rules. You choose Autopick `max_qb`, `max_k`, and `max_dst` (starter-only vs one extra, each weighed against Flex). You will also be told how many Autopick pick-by-pick slots to fill.
3. **Candidates** — JSON array of objects. Typical fields: `name` (string), `pos` (string), `team` (string), `prior_ppr` (number), `prior_ppr_season` (int), `injury_status` (string), `ir_eligible` (boolean), optional `injury_history` (object of past-season injury counts). Optional when present: `age`, `bye_week`, `depth_chart_status`. Copy `name` values exactly.

**Reply format** — JSON object only:
`{"rankings": [{"rank": 1, "name": "Player Name", "pos": "RB"}, ...], "pick_by_pick": ["RB", "FLEX", "WR", ...], "max_qb": 1, "max_k": 1, "max_dst": 1}` with exactly the requested number of rankings, exactly one Autopick preference per roster slot, and max fields of starter-count or starter-count+1.
