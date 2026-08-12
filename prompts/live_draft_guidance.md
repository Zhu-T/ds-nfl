# Live Draft Pick

- **Objective:** Pick the single best player available right now for this roster, considering pick slot, positional scarcity, board trends, and remaining starter needs.
- **One name only:** Reply with exactly one player. Prefer the Autodraft suggestion when it is a sound pick; otherwise name a better available player.
- **Must be available:** Never name anyone on TAKEN PLAYERS or CURRENT ROSTER. Those players are already drafted.
- **K / D/ST:** Only take these when remaining picks would otherwise leave those slots empty, or when they are the Autodraft suggestion late in the draft.
- **Preseason:** There are no current-year game logs. Do not invent stats.

## Pick slot

Use **Your Round 1 pick** / `your_slot` / `slot_band` from league settings and the board snapshot. Guidelines below use 12-team slots 1–4 / 5–8 / 9–12; other league sizes use the same early / middle / late bands. Apply the band you are in.

### Early (slots 1–4)

- Secure anchor talent: the first-round pick should be an undisputed, high-ceiling superstar RB or WR.
- Execute Hero RB/WR: pair that elite first-round anchor with a long run of the opposite position in rounds two through five.
- Avoid reaching: do not reach at the round 2/3 turn — the wait back to round 4 is very long.
- Predict the turn: look at the rosters of the managers at the absolute turn (first and last slots) to guess which positions they will take.

### Middle (slots 5–8)

- Play best player available: take whichever elite tier-one talent slides because managers ahead reached.
- Stay flexible: do not lock a rigid Zero RB plan from the middle — you cannot dictate the draft flow.
- Exploit positional value: grab an elite QB or TE in round three or four if a positional run drains RB/WR options.
- Build balanced depth: target reliable, high-floor WR and RB so the roster stays adaptable.

### Late & the turn (slots 9–12)

- Draft in pairs: choose two complementary players back-to-back to lock premium tiers before a long ~20-pick wait.
- Start positional runs: taking a position here can force managers behind you (and wrapping the turn) to reach.
- Embrace Hyper-Fragile or Zero RB: use the back-to-back picks to lock three elite RBs immediately, or zero RBs and stack pass-catchers.
- Draft for ceiling: take high-upside swings. Safe, predictable talent will not win from the turn.

`picks_until_next` is how many selections happen after this pick before you are on the clock again. Honor that wait: do not leave a starter hole that the board will not refill.

## Board trends

Read the taken-player list (and the board snapshot counts) after every pick. The league is telling you what is scarce.

- A **positional run** is a cluster of the same position coming off the board (for example many RBs in a short span, or RBs already a large share of all picks).
- If a run is draining a position this roster still needs (missing starters, or no plan at that position yet), **lean in** and take a strong remaining player there before the drop-off.
- If a run is draining a position this roster is already set at — or that you are deliberately fading — **do not chase the leftover**. Pivot to the next high-scoring role, usually WR, sometimes TE.
- WR is the usual pivot when RBs are flying off: elite pass-catchers keep scoring even when the RB well is empty.
- Do not invent a run. Use the taken list / snapshot counts. A couple of mixed picks is not a run.

## RB strategy

Choose one RB approach from the pick slot, the board, and this roster, then stay with it unless a run forces a clear pivot. Name it in `rb_strategy`.

- **Hero RB:** Draft one elite running back early, load up on top-tier wide receivers, then grab cheap upside rushers later. Natural fit for early slots after a superstar RB (or WR, then one RB).
- **Robust RB:** Secure heavy-workload running backs early (typically two in the first few rounds) to dominate the position.
- **Zero RB:** Skip running backs in the first five rounds and stockpile elite pass-catchers (WR, then TE). Better from the turn than from the middle.
- **Hyper-Fragile RB:** From the late turn, use back-to-back picks to lock three elite RBs immediately. High ceiling, injury-fragile.

If a prior strategy is provided from earlier picks this draft, continue it unless the taken list or slot guidelines make a pivot clearly better. When you pivot, say so in `rationale`.

Do not reach for a need if the Autodraft suggestion is clearly higher value. Scarcity, slot, and strategy inform the pick; they do not require a worse player.

## Data for this decision

You will receive:

1. **League settings** — plain text with `Format:`, `Roster:`, and draft-order lines (your slot, snake wait, teams at the turn).
2. **Taken players** — JSON array of players already drafted by anyone (`name`, `pos` when known). These are off the board.
3. **Current roster** — JSON array of players already on this team (`name`, `pos` when known).
4. **Autodraft suggestion** — JSON object `{name, pos}` or null. This is ESPN's current suggestion for this pick.
5. **Board snapshot** — counts, `your_slot`, `slot_band`, `picks_until_next`, turn-team rosters, remaining starter holes.
6. **Prior RB strategy** — the approach named on an earlier pick this draft, or `none yet`.

**Reply format** — JSON object only:
`{"player": "Player Name", "pos": "RB", "use_autodraft": false, "rb_strategy": "Hero RB", "rationale": "string"}`

Copy a player `name` exactly. Set `use_autodraft` true only when `player` is the Autodraft suggestion. `rb_strategy` must be `Hero RB`, `Robust RB`, `Zero RB`, or `Hyper-Fragile RB`.
