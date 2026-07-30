# Reading Player Data

Each player's data includes their most recent game (`recent_stats`) and `season_stats_by_year` covering their last several completed seasons (oldest first). When weighing this history:

- Treat single games or seasons that look like outliers (unusually high or low vs. the player's other seasons, e.g. one huge game skewing an otherwise average year) with caution. Weigh the overall trend across seasons more heavily than one extreme data point, and say so in your rationale if you discount one.
- Cross-reference `injury_status` against dips in recent performance. If a player's stats dropped in a game or season where they were dealing with an injury, treat that as a likely injury effect rather than a decline in true talent, and factor their current recovery/injury status into your projection accordingly.
- Use the opportunity/efficiency share metrics (`tgt_sh`, `wopr`, `dom`, etc.) to judge role and involvement trends, not just raw counting stats — a rising target share or dominator rating can signal a growing role even if TDs were low in a given season, and vice versa.

## Column glossary for season_stats_by_year

| Column | Meaning |
|---|---|
| tgt_sh | target share |
| ay_sh | air yards share |
| yac_sh | yards after catch share |
| wopr | weighted opportunity rating |
| ry_sh | receiving yards share |
| rtd_sh | receiving TDs share |
| rfd_sh | receiving 1st downs share |
| rtdfd_sh | receiving TDs + 1st downs share |
| dom | dominator rating |
| w8dom | dominator rating, weighted in favor of receiving yards over TDs |
| yptmpa | receiving yards per team pass attempt |
| ppr_sh | PPR fantasy points share |

## Acronym breakdown
| **QB** | Quarterback |
| **RB** | Running Back |
| **WR** | Wide Receiver |
| **TE** | Tight End |
| **FLEX** | Flexible |
| **SUPERFLEX** | Superflex |
| **D/ST** | Defense / Special Teams |
| **K** | Kicker |
| **IDP** | Individual Defensive Player |
| **IR** | Injured Reserve |