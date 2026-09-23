# ds-nfl

A local-first NFL fantasy football console: lineups, waivers, and trades decided by a
computed engine rather than by a language model guessing under a clock.

Built in TypeScript. Runs on your machine; your league credentials never leave it.

---

## Running it

```
run.bat              start the app, wait for it, open http://localhost:3000
run.bat build        production build, then serve it
```

Or directly:

```
npm install
npm run dev          http://localhost:3000
npm test             engine + palette tests
npm run typecheck
```

Requires Node 20 or newer.

## Building the desktop app

```
npm run dist --workspace=@ds-nfl/desktop
```

Produces `apps/desktop/dist/ds-nfl Setup <version>.exe` — about 90 MB installed
from a 317 MB unpacked tree. `npm run start --workspace=@ds-nfl/desktop` runs the
packaged shell without building an installer.

GitHub Actions (`.github/workflows/build.yml`) runs on every push to `main`. It
typechecks all four workspaces, runs the tests and builds the installer, which it attaches
to the run as the `ds-nfl-installer` artifact for 14 days. The installer is unsigned, like
a local build. CI has no league credentials, so the live ESPN tests skip themselves there.
It can also be started by hand from the Actions tab.

Electron is used rather than a bundled Node runtime because its Chromium is the
same browser needed to capture an ESPN sign-in. Driving that with Playwright
instead would add a ~433 MB browser download on top of the runtime — roughly
three times the size for the same capability.

Installed credentials live in `%APPDATA%\ds-nfl\credentials.json`, separate from
the repo's `data/credentials.json` used in development.

---

## Layout

```
apps/web/            Next.js App Router: the UI and its server actions
apps/desktop/        Electron shell and the Windows installer build
packages/core/       the engine: scoring, exact lineup optimizer, waiver value (pure, no I/O)
packages/adapters/   ESPN and Sleeper reads, ESPN lineup writes, the local credential store
packages/llm/        optional AI explanations: Claude, or a local model through Ollama
prompts/             the previous version's strategy prompts, kept for reference; unused
docs/                reverse-engineered ESPN protocol notes
```

## Connecting leagues

Connect as many ESPN leagues as you like under **Settings**. One is active at a
time, and every page shows it; switch from the sidebar or the Connect page. Each league
keeps its own AI conversation.

- **Leagues on your account are one click.** Once cookies are saved, the Connect page
  lists every football league on that ESPN account, with your team already identified.
  Adding by league id is still there, for a league on a different account.
- **Cookies belong to the account, not the league.** A second league on the same account
  needs no new cookies. When ESPN stops accepting them, **Renew ESPN cookies** updates
  every connected league signed in with that SWID at once.
- **Actions stay with their league.** Applying a lineup, drafting a trade message, and
  asking the League AI all act on the league the page was showing, even if another
  league was made active in another window since.

A credentials file written by an earlier version, which held one league, is migrated when
it is read. Nothing needs re-entering.

## How it decides things

Everything is computed and testable. The engine holds no ambient state — it takes a
league's scoring rules and roster settings as arguments — so multiple leagues and
multiple teams work without special cases.

**Scoring.** A league's complete rule set is parsed into typed rules (per-unit, per-N,
thresholds, and D/ST bands) and applied to stat lines. Any platform rule that cannot be
mapped is surfaced to you rather than silently scored as zero.

**Lineup.** With FLEX/OP slots, setting a lineup is a bipartite assignment problem, not a
sort. A greedy "best player into the best slot" pass is provably wrong — it will strand
your best receiver in the flex and leave you without a WR2. The optimizer solves it
exactly; the test suite includes a roster where greedy scores 25 and the exact solver
scores 45, plus property tests against brute-force search.

**Projections.** Every number comes from ESPN: its weekly projection for each player,
already scored under your league's rules (the app scores ESPN's actual stats itself and
matches ESPN's totals exactly). Nothing is blended in from other sources yet. nflverse is
not downloaded or used at runtime; the only traces are its `gsis_id` naming and a
season-resolution helper kept for a future projection source of our own.

**Players.** Every rostered player in your league and who has them, plus the top
unrostered players, whether on waivers or free agents. A search box filters that list as
you type, with no request to ESPN. Each word must start a word of the name, so "st brown"
and "jamarr" work. When no name matches, the position, NFL team, and owner are searched
too ("wr det", "waivers", a fantasy team name).

**Waivers.** Available players are ranked by what each would add to your starting lineup
for the week shown: the optimizer runs with the player added, and the difference is the
value.

- The players considered are the 150 best projected for that week plus the 50 most
  rostered, plus the 40 being added most across ESPN.
- **Trending adds** ranks available players by ESPN's rostered +/-: the change in the
  percent of ESPN leagues rostering them. These are likely streamers, often before their
  projection catches up. Each still shows what they would add to your lineup this week.
  Elsewhere a rise of a quarter-point or more is shown beside the player. The League AI's list
  of available players includes the 8 most-added. Snapshots and the results export record
  each player's rostered percent and change.
- **High ceiling** ranks pickups by how much each raises your **chance of winning this
  week's matchup**, for when a loss looks likely and a boom game is what you need.
  - **Win chance.** Both starting lineups are priced with the app's projections. Each starter
    gets the spread typical for their position and projection. Games already over count at
    their actual score.
  - **Ceiling.** The score a player beats one week in ten.
  - **Simplifications.** Players are treated as independent and scores as bell curves.
  - **Tested.** `npm run calibrate-ceilings` fits on 2024 and checks on 2025. 9.5% of
    player-weeks beat the ceiling. Three extra signals were tested the same way, and none
    helped enough to use:
    - a player's own boom history: past boom rates of 1% to 23% gave 9.1% to 10.0% the
      next week;
    - their coefficient of variation;
    - the implied team total.
- **Upside lineup** on the Lineup page is off by default. Switched on, it shows the lineup with
  the best chance of winning next to the best-projected one, with both chances. It has its
  own Apply, which recomputes that lineup on the server. It never replaces the main lineup
  or its Apply.
- **This week or through week N.** A switch ranks by this week's gain or by the running
  total from this week through the three after it ("Through week 5" in week 2). Later weeks use ESPN's rest-of-season projection
  per game and each NFL team's bye weeks, so a player who would sit now but covers a bye or
  out-projects your flex from here on still shows. Both numbers are on every row.
- **Protected players** are never suggested as a drop, and cannot be dropped for a pickup.
  Mark them on the Waivers page, under "Protected from drops". This is your own note about
  your roster: nothing is sent to ESPN, and it is saved per league in
  `data/<league>.protected.json`. The League AI is told which players are protected. Note
  that "locked" elsewhere means a player's game has started, which is ESPN's doing rather
  than yours. Trades still show and value swaps involving a protected
  player, since knowing what they are worth is useful, but the message to the other manager
  cannot be drafted until you unprotect them.
- **Suggested drops** are the players your lineups would miss least across those weeks,
  not simply the lowest projection. Costs within half a point count as a tie, broken by the
  position with the most spare players for each one it starts, so a third quarterback in a
  one-quarterback lineup goes before a fifth receiver, who is injury cover for several
  slots. IR-slot players are never suggested.
- Rest-of-season projections are ESPN's and conservative: few waiver players gain much on
  them. Breakout potential shows up sooner in the injured-starter flags, recent form, and
  web picks.
- Ownership alone used to miss low-owned players with a real role that week. In week 3 it
  missed a 15-point QB, seven kickers, and a defense, while players projected for nothing
  took up slots.
- **Waiver picks from the web**, on the Waivers page, finds who the fantasy press
  recommends adding. Claude searches the web; a local model reads this week's waiver
  headlines (plus article text if an Ollama web search key is saved).
- Each pick must cite a retrieved source. It is then compared with your league's players
  and labelled: available as a free agent or waiver claim (shown with what it would add
  to your lineup), rostered by a named team, or not found. Positions come from ESPN, not
  from the model.
- A local model can skip names a headline lists. So the app also scans the gathered
  headlines itself, and adds every available player named in full, with how many
  articles named them.
- Only articles from the last 7 days are read, as for the news check below.
- The ranking itself is unchanged, because the press often recommends players for the
  weeks after this one.
- **Evaluate a player**, at the top of the Waivers page, takes any name. Rostered players
  are matched in the league's rosters ("jamarr" finds Ja'Marr Chase) and everyone else
  through ESPN's name search; when several match, you pick one. It shows:
  - where the player is: free agent, waivers, another team, or your roster;
  - their projection, ESPN's with betting lines and news applied, and their game;
  - what they would add to your best lineup, the slot they would fill, and who they
    would start over and who to drop. For one of your own players, it shows what losing
    them costs and who would start instead;
  - for another team's player, the one-for-one trade that helps both lineups most, if
    any does;
  - the last 7 days of news on them from the web, filled in just after: ESPN's player
    updates, Google News headlines that name them, and Ollama web search when a key is
    saved, each with its source and date;
  - with AI on, the model's reading of that news under the news check's rules (it must cite
    what it read, and stays within the fixed range for its status), and the player valued
    again if it changes their outlook. That reading is not saved; the news check on the
    lineup page is what applies news to the lineup, waivers, and trades.

  It uses the same numbers as the ranking: the best lineup with the player minus the best
  lineup without them, valued as if no game had kicked off.

**Betting odds.** On by default, with a switch on the lineup page. Projections blend
ESPN's with the betting market, using DraftKings lines from ESPN's public odds endpoints
(no key).

- For each stat a sportsbook posts an over/under for (passing, rushing, and receiving
  yards, and receptions), ESPN's projected value and the line are averaged. The stat line
  is then rescored under your league's own rules, so receptions count in PPR and not in
  standard.
- Touchdowns stay ESPN's. A touchdown line of 1.5 is a threshold, not an expectation, and
  ESPN publishes no anytime-touchdown prices.
- Lines are the market's middle outcome; yardage averages run a little higher, so the
  blend slightly tempers upside.
- Each player card shows "market X · ESPN Y" and the team's total from the game line
  (spread and over/under). The lineup, waivers, trades, and the League AI brief all use
  the blended numbers.
- Sportsbooks post player props through the week. Early on, many players have none, and
  the page says so rather than blending anything.
- **Lines are calibrated before they are blended.** Props come out game by game and move
  as kickoff nears, so at any moment some players are priced by the market and the rest by
  ESPN alone. If lines as a whole sit above or below ESPN, the players whose props are out
  would gain or lose for that alone. So each line is divided by the week's typical
  line-to-ESPN ratio for its stat, measured separately for games within 36 hours of kickoff
  and later ones, over every player with props (not just the page's). A measured ratio is
  pulled toward no correction until a dozen lines back it. On week 2's Monday game,
  yardage lines sat 7-9% below ESPN and reception lines 5% above.

**Recent form.** On by default, with its own switch on the lineup page. A projection is an
average expectation and is slow to follow a player whose role or play has changed, so each
one moves a little toward what the player has actually scored this season, under your
league's scoring. The numbers come from the same ESPN reads as the projections, so this
costs no extra request.

- Like the opponent adjustment, this one is cautious: a player's own games count as much as three
  games of their projection, so after one game only a quarter of the difference counts; half
  of what remains is applied; and the change is capped at 10% either way.
- A player with betting lines blended in is left to the market, which prices form better.
- Order: ESPN's projection, betting lines, the opponent (D/STs), recent form, then any news
  finding. Player cards show it, e.g. "form: 30.1 a game over 1 game, ×1.10", and the AIs
  are told what each player has actually scored.

**Injured teammates.** When the player an NFL team leans on at a position is out, doubtful,
suspended, or on IR, the next players up are flagged "role may grow" on the lineup page, the
waiver list, and in player evaluations. Who a team leans on is read from how widely each
player is rostered across ESPN leagues (at least 40%, and 10 points clear of the next), and
the status from ESPN's injury report. It changes no number on its own, since ESPN's
projection often already reflects the injury. Instead it is handed to the models: the news
check reads it with each player (and also checks up to four waiver backups whose lead is
out), and may report a bigger role, citing the news, within its fixed range.

**Opponents.** On by default, with a switch on the Lineup page. Only **D/ST** projections
move with the opponent. Each moves toward how D/STs have scored against that offense this
season, relative to their own ESPN projections, from finished weeks only.

- **Measured against projections, not points allowed.** A defense that has faced strong
  offenses allows more points without being any weaker. ESPN's opponent rank (OPRK) and
  points allowed don't account for that. What players scored beyond their own projection is
  what the projections missed about the opponent, with each offense's quality already
  counted.
- **Why only D/STs.** `npm run backtest-opponents` replays a past season from ESPN's public
  data. Every player-week from week 2 on is projected using only earlier weeks. In both 2024
  and 2025:
  - moving D/ST projections this way cut squared error by 1.6% and 2.5%;
  - for every offensive position, any opponent adjustment made ESPN's projection worse.
    Points allowed was the worst, at up to 1.8%; ESPN already prices the opponent.
  - So QBs, RBs, WRs, TEs and kickers keep ESPN's projection.
- **Sizing.** An offense's record counts as much as four ordinary games, so one game carries
  a fifth of its weight. The change is never more than 20% either way.
- **Order:** ESPN's projection, betting lines, the opponent, recent form, then any news
  finding. The lineup, waivers, trades, player evaluation and the League AI brief all use
  it, e.g. "@ ATL: D/STs 164% over projection vs them, ×1.20".
- **Streamers at other positions:** see Trending adds under Waivers.

**Next week.** While a week is being played, the week switch in the top bar plans the next
one: its lineup (nothing is locked yet), the matchup against next week's opponent (whose
total is the best lineup their roster can field, since theirs is not set), and waiver and
trade values on that week's projections, since a pickup made now plays then. **Apply**
writes the lineup for the week shown.

**News check.** In the News section at the bottom of the lineup page, next to ESPN's player
updates, **Check the news** looks for news on your players and the top pickups for the week
shown. When it changes a projection, a line under the verdict says so and links down to it. How it looks depends on the AI provider:

- **Local model (Ollama), no API key.** The app gathers the last week of news itself: ESPN's
  player updates, and headlines from Google News that name the player. Only headlines are
  taken; articles are not fetched. The model reads that material in one request and cites
  items by number. Ollama's context window is set to fit the prompt, since it otherwise
  cuts long prompts off without an error.
- **Optional: Ollama web search.** Adding a key from a free ollama.com account (under the
  Ollama choice on the Connect page) adds one web search per player. That gives page text,
  not just headlines. Only player names are searched, and the local model still does the
  reading. The key is checked with one small search before it is saved. A rejected key or a
  rate limit stops the searches and says so, and the check finishes with the free sources.
- **Claude.** Claude runs its own web searches.

Only news from the last 7 days is used. ESPN's updates and Google News headlines are
limited to that week. Web search results carry no date of their own, so a page counts only
if it states a date inside the week; undated pages are dropped. Claude is given the
cutoff date, and a finding whose only sources its search dates as older is dropped.

This is the one place a model's output changes a recommendation, so each finding must pass
these checks:

- It names a player the app asked about.
- It cites sources the app knows were retrieved. For Claude, those are pages its search
  returned; a URL it merely writes down does not count. For the local model, those are
  items gathered about that same player.
- It moves the projection only within a fixed range for its status. Out sets a player to
  0. Doubtful allows 0 to 0.5 times the projection, questionable 0.5 to 1, and a role
  change 0.75 to 1.25.

Findings are saved per league and week and applied to the lineup, waivers, trades, and the
League AI brief. Each one is listed with its sources and can be ignored. Ignoring or
removing findings saves at once and does not run the check again. A check only runs
when clicked. With Claude it is billed to your Anthropic account (web searches plus tokens).
With the local model it is free, and takes a few minutes.

### How it's doing

A page grading the app against what happened, from the weekly results below. Only players
priced **before kickoff** count, so nothing is scored with hindsight.

- Each week: what you scored, what the recommended lineup would have, the best possible, and
  what the bench outscored the lineup by.
- Each adjustment judged **on its own**: the projection that went out against the same
  projection with that one factor removed. Betting lines are compared with ESPN's number;
  the opponent and form factors are divided back out. Under 40 player-weeks it says "too
  early to tell" rather than showing a number.
- News findings by direction, web picks against everyone available at their position, and how
  often players beat their ceiling (one in ten is right).

If an adjustment is shown to make projections worse over enough weeks, it should be switched
off by default, as ESPN's opponent ranks were.

### Coming weeks and playoff odds

- **Playoff odds** play the rest of the season out 10,000 times. Each team scores what its
  best lineup projects from here on, with the spread its players carry; seeding is by record
  with points for as the tiebreak, as ESPN does it. It also shows which remaining week swings
  your odds most. The week being played is simulated fresh, so live scores do not count
  toward it, and nobody's future pickups are guessed at.
- **Coming weeks** shows where byes and injuries leave you short of a full lineup over the
  next six weeks, with the best available player who does play that week for each hole.

### Adding and dropping

Waiver rows have an **Add** (or **Claim**) button. It opens a confirmation showing both
sides of the move before anything is written:

- **In:** the player, their projection, what they add to your lineup this week and across the
  coming weeks, and the starter they would displace.
- **Out:** whoever you pick to drop, and what losing them costs your lineups over those
  weeks. Every one of your players is listed with their cost, cheapest first, and protected
  players are left out. When the suggested drop is not the cheapest, it says why: costs
  within half a point are a tie, broken by the position where you have most spare players.
- **Net** over those weeks, and whether this goes through at once or waits for the waiver run.
- In leagues with a FAAB budget, what to bid and what is left.

Confirming writes through the same transactions endpoint lineups use.

**Pending** is its own page: what you have put in and not yet had settled, when the waivers
run in your league, and how your last few moves actually ended — went through, cancelled, or
failed, with ESPN's reason. Waivers links to it, marks a player you have already claimed as
"claim pending" so they cannot be claimed twice, and leaves a player already on the way out
off the drop list. The League AI is told about them too.

Working out what is really pending takes care, because ESPN's log is append-only:

- Cancelling a claim **appends** a `CANCELED` row and leaves the original saying `PENDING`.
- Claims whose drop player has since gone stay `PENDING` for ever.

So a claim counts as live only when nothing later settled the same swap and the players still
make sense against your roster; the rest are folded away as "ESPN still lists these but they
cannot happen". A claim is **not** assumed to succeed either: projections, lineups and waiver
value all still treat your roster as it is today.

- Nothing is written without that confirmation, and the app never acts on its own.
- The server checks everything again: that the player is still available, that the drop is
  on your roster, and that their game has not started.
- A free agent is added at once and confirmed by reading the roster back. A waiver claim is
  reported as **submitted**, never as done: ESPN settles it at the next waiver run.
- The suggested bid is a stated rule of thumb, not a fitted model.

### Weekly results

The app records every week, so it can be checked against what happened and the data can
be used for model training. The files are kept in `data/results/`, beside the credential
store; the desktop app keeps them under `%APPDATA%\ds-nfl`.

- **Before kickoff:** the Lineup and Waivers pages save a snapshot of each player they
  price. It holds ESPN's projection, the app's projection, the betting-line blend, the
  matchup and form factors, the news finding, and the recommended slot or pickup gain.
  A player's entry stops changing once their game locks.
- **After the week:** on the next page load after the week ends, the app reads every
  rostered player's actual points and the lineup you set. It joins them to the snapshot,
  the news findings and the web waiver picks. Weeks from before recording began get
  ESPN's projections only.
- **On the Lineup page:** a line shows last week as played. It compares your lineup's
  score with what the recommended lineup would have scored and with the best possible.

`npm run export-results` writes `player-weeks.jsonl` (one row per player per week) and
`lineup-weeks.jsonl` into the results folder. To export the desktop app's data, pass its
folder: `npm run export-results -- "%APPDATA%\ds-nfl"`.

## AI explanations (optional)

Off by default, and optional in the strongest sense: with it off, every number and
recommendation in the app is identical. Turn it on under **Settings**.

- **Claude** (`claude-opus-5` at low effort, with Anthropic's server-side refusal
  fallback) needs an API key, which is checked with a free request before it is saved.
- **A local model through Ollama** is free and private. With `deepseek-r1:14b` on this
  machine an answer takes about 10 to 25 seconds.

It does three things, only when you ask: explains the lineup recommendation, adds a
reason to a trade offer, and answers questions on the **League AI** page. It never picks a
lineup, values a trade, or changes anything on ESPN. Two rules keep it honest:

- **Numbers.** It sees only the facts the engine computed, and any text containing a
  number that is not in those facts is withheld rather than shown.
- **Trade terms.** Who sends which player is written by the app, never the model. When the
  local model wrote whole messages it reversed the trade in 2 of 6 drafts; now it writes
  only the reason, and a reason that names the player the other manager would give up is
  rejected.

### League AI

One page per connected league (**League AI** in the sidebar) with two parts:

- **What the AI knows**: the exact brief the model receives, section by section. It covers
  this week's lineup and matchup (every recommended starter and bench player, each with
  their NFL matchup and any injured teammate ahead of them), your roster with injury and
  lock notes, the top waiver
  pickups, a short list of the best available players at each position, the best trade
  ideas, and the last 7 days of news on your players. It is rebuilt from ESPN at most every
  two minutes.
- **The league's player list**: every rostered player and who has them, plus the top
  unrostered players with what each would add to your lineup (about 400 in all). It is
  saved per league and week (`data/player-lists/`), and rebuilt when it is over 10 minutes
  old, when the news check or web picks change, or on **Refresh the list**. For each
  question the app looks up the players, fantasy teams, and positions it names, and sends
  just those rows with it. "Is Shough worth a claim?" gets Shough's row, "What running
  backs does Ceebee have?" gets that team's backs, and "Any tight ends worth adding?" gets
  the 10 best unrostered tight ends. A follow-up that names no one reuses the rows the
  question before it named. The model never searches the list itself; the chat shows what
  was looked up under each question.
- **Moves worked out for you.** When a question asks about adding, dropping, or trading
  players it names ("should I drop Bo Nix to add KC Concepcion?", "should I trade Kenny
  Gainwell for Chase Brown?"), the app computes each move with the Waivers page's math:
  what it adds this week and through the coming weeks, the player your lineups would miss
  least, and for a named trade, what it does to both teams. The model reasons from those
  rows rather than adding up lineups, and the number check accepts their figures.
- **Reasoning.** A separate model can be chosen for the chat under the Ollama settings,
  such as deepseek-r1:14b, which reasons; its reasoning is shown under each answer on
  request. It is for questioning the answer, and is not checked: only the answer goes
  through the number check.
- **A chat** scoped to that league. Earlier turns go back with each question, and the
  conversation is saved on this computer, one file per league: `data/conversations/` in
  development, and a `conversations` folder beside the desktop app's credentials.
  **Clear this conversation** deletes it. An answer may quote numbers from the brief, the
  rows looked up for any question so far, or your own messages. One that uses any other
  number is retried once and otherwise withheld, and withheld answers are kept out of later
  turns. With a local model the context window is sized to fit the brief and the
  conversation (8,192 to 32,768 tokens), since Ollama otherwise cuts long prompts off
  without an error.

The number check cannot catch claims without numbers, and local models in particular pad
answers with general fantasy advice. The brief on the same page is the reference.

### Player news

The lineup page lists the last 7 days of ESPN's player blurbs for your roster, and the
same items go into the League AI brief. General articles that only mention a player (a
"top 10 scorers" column appears under every player it names) are filtered out. News loads
after the lineup, so a slow feed never delays it.

## Data sources

| Source | Auth | Provides |
| --- | --- | --- |
| ESPN `kona_player_info` | none | ADP, auction values, eligible slots, actual and projected stat lines, weekly actual points |
| ESPN league views | `espn_s2` + `SWID` | Your roster, scoring settings, draft detail, transactions |
| ESPN fantasy news feed | none | Player blurbs for your roster, last 7 days |
| Google News search RSS | none | Headlines naming a player, last 7 days (news check) |
| Ollama web search API | free ollama.com key, optional | Page text per player (news check) |
| ESPN scoreboard odds | none | Spread and over/under per game (team totals) |
| ESPN core odds (DraftKings) | none | Player prop lines: yards and receptions |
| ESPN fan API | `espn_s2` + `SWID` | The football leagues on your account, with your team in each |
| Sleeper | none | Full league read |

nflverse is not a live data source. If it is added later (for rest-of-season value or
usage data), note that it publishes schedules and rosters for the current season ahead of
time but has almost no stats until several weeks in: 135 stat rows for 2026 against 19,422
for 2025, as of week 1. Season fallback must be decided per dataset, or last season's bye
weeks come back looking entirely plausible. `packages/core/src/data/seasons.ts` does that.

## Status

Working today: the engine and UI; read adapters for **ESPN** and **Sleeper**; **ESPN
lineup writes**; the waiver, trade, player, and scoring pages; player news; several leagues side by side, added in one click from your ESPN account;
and optional AI explanations plus a per-league AI chat. Connect an ESPN league
and it shows your real roster, that week's matchup, and the changes worth making — then
applies them. With nothing connected it falls back to a clearly-labelled sample roster.

Lineup writes go straight to ESPN's transactions endpoint as plain HTTP with the same
cookies the reads use — no browser automation. A write is only reported as done after
the roster is read back and matches. Players whose game has kicked off are locked: the
optimizer holds them in place, and the writer refuses them up front by name rather than
letting ESPN reject the request.

Not built yet: **executing** adds, drops, and trades (the waiver and trade pages advise;
you still make the move on ESPN), projections of our own (which Sleeper leagues need,
since Sleeper publishes none), and draft tooling, which is an off-season phase.

Two rules the previous version broke, now enforced:

- **An adapter that cannot authenticate throws.** It never substitutes placeholder
  data. The old code returned a fabricated roster on auth failure, and those invented
  players reached recommendations that were then acted on.
- **Capabilities are data.** Each adapter declares what it can do, so the UI greys out
  what a platform genuinely cannot support — Sleeper has no write API at all, and
  publishes no projections, which is why lineup advice there needs a projection source
  of our own.
