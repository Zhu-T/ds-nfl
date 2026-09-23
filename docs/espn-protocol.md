# ESPN Fantasy Football — Protocol Notes

Reverse-engineered knowledge distilled from the previous Python implementation and from
live probing. ESPN publishes no documentation for any of this; it can change without notice.

**This file contains no credentials.** The probe captures it was distilled from did contain a
live Disney/BAMGrid JWT and session cookies, and were deleted.

---

## 1. Hosts

| Host | Use |
| --- | --- |
| `lm-api-reads.fantasy.espn.com` | All reads (league views, player feed) |
| `lm-api-writes.fantasy.espn.com` | Writes (draft strategy) |
| `fantasy.espn.com` | The web UI, for Playwright automation |

Base path for both API hosts: `/apis/v3/games/ffl/seasons/{season}`.

## 2. Authentication

Two cookies: **`espn_s2`** and **`SWID`** (SWID includes surrounding braces). There is no
programmatic login — ESPN's login is a Disney OAuth flow behind a bot wall.

The working approach, and the one to keep:

1. Make cheap HTTP requests with the stored cookies.
2. Only on **401/403**, launch a headful Playwright persistent-context browser.
3. Wait (poll) for the human to complete login.
4. Harvest `espn_s2` / `SWID` from the browser cookie jar.
5. Retry the original request **exactly once**.

Logged-out detection selector that worked:

```
a:has-text('Log In'), button:has-text('Log In'), [data-affiliatename], a[href*='login.espn.com']
```

## 3. League reads (cookies required)

```
GET /apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{leagueId}?view={view}
```

| View | Contents |
| --- | --- |
| `mSettings` | Scoring rules, roster/lineup slot counts, draft settings |
| `mRoster` | Every team's roster with `lineupSlotId` per player |
| `mTeam` | Team names and owners |
| `mDraftDetail` | Draft picks, `playerId`-keyed — authoritative for board state |
| `mTransactions2` + `mPendingTransactions` | Completed and pending trades/waivers |

## 4. Player feed — unauthenticated, and the most valuable endpoint

```
GET /apis/v3/games/ffl/seasons/{season}/players?scoringPeriodId=0&view=kona_player_info
    x-fantasy-filter: {"players":{"limit":N,"sortPercOwned":{"sortAsc":false,"sortPriority":1}}}
    x-fantasy-platform: espn-fantasy-web
    x-fantasy-source: kona
```

**Verified 2026-09-13: returns HTTP 200 with no cookies at all.**

- Season 2025 → ~22 MB, 2,876 players
- Season 2026 → ~39 MB, 11,617 players

Each player carries `averageDraftPosition`, `auctionValueAverage`, `percentOwned`,
`draftRanksByRankType`, `injuryStatus`, `eligibleSlots`, and a `stats` array where:

- `statSourceId: 0` → **actual** production
- `statSourceId: 1` → **ESPN's own projection**

entries are split by `scoringPeriodId` (0 = full season, 1..18 = weeks) and carry both a raw
`stats` map keyed by statId and an `appliedTotal` under ESPN's default scoring.

> **Gotcha:** the `limit` inside `x-fantasy-filter` was *not honored* as written above during
> testing — the full payload came back regardless. Either get the filter shape right, or
> accept the full payload and cache it. Never put this call on a request path.

The previous implementation called this endpoint and discarded everything except IR
eligibility.

## 5. ID systems — the expensive gotcha

ESPN uses **two different numeric position systems**, and mixing them silently produces
wrong-but-plausible results.

**`defaultPositionId`** — what position a *player* is. Used in `roundStrategy.positionIds`
and `positionStrategy.positionId`:

| QB | RB | WR | TE | K | D/ST |
| --- | --- | --- | --- | --- | --- |
| 1 | 2 | 3 | 4 | 5 | 16 |

**`lineupSlotId`** — what *roster slot* a player occupies. Used in `mRoster` and in roster
settings:

| Id | Slot | Id | Slot |
| --- | --- | --- | --- |
| 0 | QB | 17 | K |
| 2 | RB | 20 | Bench |
| 3 | FLEX (RB/WR/TE) | 21 | IR |
| 4 | WR | 23 | FLEX |
| 6 | TE | 24 | RB/WR |
| 7 | OP (superflex) | 25 | WR/TE |
| 16 | D/ST | | |

RB (2) and D/ST (16) happen to collide across the two systems, which is exactly why the bug
is hard to notice.

FLEX round-strategy expands to player position ids `(2, 3, 4)`; OP/superflex to `(1, 2, 3, 4)`.
`-1` means "best available".

## 6. Scoring settings

`mSettings` returns `scoringItems`, each `{statId, points, ...}`. **The previous code read
only `statId: 53` (receptions)** to decide "is this PPR?", discarding every other rule — no
passing-TD value, no 4pt-vs-6pt, no bonuses.

A full scoring engine needs the complete statId → stat-name mapping. Only `53 = receptions`
is confirmed from the old code. **Derive and verify the rest empirically**: re-score a
completed week and assert the computed total equals ESPN's reported `appliedTotal` for every
player. That check validates the statId map and the ID crosswalk at the same time, and should
be a test — not an assumption.

## 7. Draft strategy write (undocumented)

```
POST /apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{leagueId}/teams/{teamId}
Host: lm-api-writes.fantasy.espn.com
Content-Type: application/json
x-fantasy-platform: espn-fantasy-web
x-fantasy-source: kona
```

```json
{ "draftStrategy": {
    "draftList":         [{ "playerId": 3139477 }],
    "excludedPlayerIds": [],
    "roundStrategy":     [{ "roundId": 1, "positionIds": [-1], "statId": -1 }],
    "positionStrategy":  [{ "positionId": 1, "minimum": 1, "maximum": 2 }] } }
```

`positionIds` and `positionId` use **`defaultPositionId`**, not `lineupSlotId` (§5).

ESPN rejects some position ids per league. The working mitigation was a retry loop that reads
ESPN's own error text:

```
/position\s+(\d+)\s+does not exist/i
```

bans that id, rewrites the affected round preferences to best-available (`-1`), and retries.
If `positionStrategy` is rejected wholesale, drop the min/max block and retry without it.

Read the current strategy back from `mTeam` → `teams[].draftStrategy`.

## 8. Playwright techniques for the draft room

URL: `https://fantasy.espn.com/football/draft?leagueId={id}&seasonId={season}&teamId={team}`
(a mock room is the same page under a different URL — one code path serves both).

**Scrape the whole board in one `page.evaluate()`** rather than many locator round-trips.
Return `{ myTurn, autopickOn, autodraftSuggestion, myTeam, picked, draftComplete }` in a
single call; the draft clock does not tolerate chatty automation.

**Turning Autopick off** — it is a React controlled checkbox, so a plain `.click()` gets
reverted by React. The working override:

```js
Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked')
      .set.call(input, false);
input.dispatchEvent(new Event('click',  { bubbles: true }));
input.dispatchEvent(new Event('input',  { bubbles: true }));
input.dispatchEvent(new Event('change', { bubbles: true }));
```

Then **verify and retry** — the old code needed up to 6 attempts. The checkbox's `checked`
property also lies; the reliable read was the indicator's **computed background colour**
(green channel meaningfully above red ⇒ on).

**Drafting a player — three escalating fallbacks:**

1. Click the banner draft button (`.pickArea button.Button--draft`).
2. Type the name into `input[placeholder="Player Name"]` with
   `press_sequentially(..., delay=35)`, then click the match.
3. Find the name cell in the `react-virtualized` / `fixedDataTable` grid and walk to its row.
   If the row walk fails, align **geometrically**: match the button whose bounding-box `top`
   is within ~22px of the name cell's `top`.

**Board reconciliation.** The DOM and the API disagree. Treat `mDraftDetail` (playerId-keyed)
as truth, fuzzy-match scraped DOM names onto it to backfill positions, then positionally zip
leftover scraped names onto still-unnamed API picks ordered by overall pick.

## 8b. Adds, drops and waiver claims (verified 2026-09-23)

Same endpoint as the lineup write, `POST .../leagues/{id}/transactions/`, with the same two
cookies. The envelope differs only in `type`:

| Field | Value |
| --- | --- |
| `type` | `FREEAGENT` for an immediate add, `WAIVER` for a claim |
| `bidAmount` | the FAAB bid, in leagues with a budget |
| `items` | `{ playerId, type: 'ADD', toTeamId, toLineupSlotId }` and `{ playerId, type: 'DROP', fromTeamId, fromLineupSlotId }` |

**Each item must name its team.** An ADD without `toTeamId` is rejected with HTTP 409 and
`Required field toTeamId missing from ADD TransactionItem`. A lineup move needs no team,
because the player is already yours — which is why the shape reconstructed from `LINEUP`
items failed the first time it was sent for real.

A `WAIVER` post returns 200 and the claim shows as `WAIVER`/`PENDING`, with the roster
unchanged until the waiver run; ESPN rewrites the drop item's `fromLineupSlotId` to -1. So a
claim cannot be confirmed by reading the roster back, only from the transaction list. A
`FREEAGENT` post applies at once and can be read back.

**Reading them back is not where you would expect.** `view=mPendingTransactions` answers
with a `pendingTransactions` array only sometimes, and otherwise omits the key entirely —
observed both ways within an hour on the same league. `view=mTransactions2` reliably returns
every transaction with a `status`, so pending claims are read from there, filtered to
`PENDING` and your own `teamId`. Other teams' claims are not disclosed.

ESPN also leaves **stale** claims as `PENDING`: ones whose drop player has since gone, or
whose add already landed. Anything acting on this list has to check it against the roster
first; one real team had eight pending rows of which one was still possible.

## 9. Ancillary endpoints seen in traffic captures

Observed in the draft-room network captures. Not currently used, but two are worth knowing.

| Endpoint | Notes |
| --- | --- |
| `fan.api.espn.com/apis/v2/fans/{SWID}` | **League discovery.** Returns the leagues the signed-in user belongs to. This removes the need to make the user hand-type a league id — connect should offer a pick-list instead. |
| `presence.fantasy.espn.com/apis/v1/heartbeat` | Draft-room presence ping. The draft UI expects it; going silent may mark you idle and hand picks to Autodraft. Worth replaying if a draft session behaves as though it thinks you left. |
| `lm-api-communication.fantasy.espn.com/apis/v3/communication/lastReadByMember` | League chat read state. Not needed. |
| `mystique-api.fantasy.espn.com/apis/v1/domains/lm/images/{uuid}` | League/team images. Cosmetic. |

`dcf.espn.com`, `go.web.plus.espn.com`, and `tvid` requests are Disney ad/analytics and are
irrelevant — but note they are the same subsystem whose refresh tokens leaked into the
captures, so do not replay traffic from those hosts.

## 10. Other UI URLs

| Purpose | URL |
| --- | --- |
| Team / lineup | `fantasy.espn.com/football/team?leagueId={id}&teamId={team}` |
| Edit draft strategy | `fantasy.espn.com/football/editdraftstrategy?leagueId={id}` |
| Mock draft lobby | `fantasy.espn.com/football/mockdraftlobby` |

## 11. Things the old implementation got wrong

Recorded so they are not reintroduced.

- **Lineup writes never worked.** The code clicked "Move" to enter swap mode, never clicked a
  destination slot, then clicked Save and logged success unconditionally.
- **Auth failures returned fake data** — a hardcoded roster, a fake 12-team league, a fake
  trade — which then fed the model. An adapter that cannot authenticate must throw.
- **Scoring was reduced to one statId** (§6).
- **Roster settings round-tripped through a string** (`"1 QB, 2 RB, ..."`) and were re-parsed
  by regex in two separate places. Keep them structured.

## 12. Player news

```
GET https://site.api.espn.com/apis/fantasy/v2/games/ffl/news/players?limit=3&playerId={espnPlayerId}
```

No cookies. Returns `{ feed: [...] }`; each item has `id`, `playerId`, `headline` (one
sentence), `story` (a paragraph of fantasy analysis), and `published` (ISO time) — the
blurbs ESPN shows on player cards. Verified 2026-09-14.

Each item has a `type`. `Rotowire` is a blurb about that player; `Story` is a general
article that mentions them (the same "top 10 scorers" column appears under every player
it names) and `Media` is a video. The app keeps `Rotowire` only, and asks for `limit=10`
so articles do not crowd the blurbs out.

Every player object in the league views carries `lastNewsDate` (epoch ms), so the app only
requests news for players whose last item is recent.

`site.api.espn.com/apis/site/v2/sports/football/nfl/news` is general NFL news with no
player ids, and `fantasy.espn.com/apis/v3/games/ffl/news/players` no longer returns JSON;
neither is used.

## 13. The account's leagues

```
GET https://fan.api.espn.com/apis/v2/fans/{SWID}?context=fantasy&source=espncom-fantasy-lm
```

Same two cookies as the league reads. `preferences[]` lists every fantasy product the
account has joined. Football leagues are the entries whose `metaData.entry.abbrev` is
`FFL`, and each gives:

- `entryId`: your team id in that league
- `seasonId`
- `groups[0].groupId` and `groups[0].groupName`: the league id and name

The entry's `name` is the product ("Fantasy Football 2026"), not the team. Verified
2026-09-14.

This is how the Connect page offers one-click adds. Finding the team id in ESPN's URLs was
the most confusing step of connecting. The SWID is part of the URL, so the app keeps it out
of every error message.

Previous seasons of a league that is re-created each year (a new league id per season)
return 404 from the league endpoint, so a "2025" of this league is not readable.

## 14. Weeks other than the current one

League reads answer for the current scoring period unless `scoringPeriodId` is passed. That
covers both the lineup slots and which week's projections are included. So planning week 2
during week 1 needs `&scoringPeriodId=2` on `mRoster` (and on `kona_player_info` for free
agents). Verified 2026-09-14: all 15 roster players and the free agents returned week-2
projections, and the week-2 read showed no locks.

`mStatus` gives `status.finalScoringPeriod` (17 for this league). The schedule in
`mMatchupScore` already lists every matchup period, so next week's opponent is known in
advance. Their projected total for a future period is not meaningful; the app computes
their best possible lineup instead.

## 15. Betting odds

```
GET https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week={w}&dates={season}
```

`events[].competitions[0].odds[0]` gives `spread` (the home team's number: -4.5 means the
home team is favored by 4.5) and `overUnder`, from DraftKings. Implied points are
home = (total - spread) / 2 and away = (total + spread) / 2. All 16 week-2 games had
lines during week 1.

```
GET https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/{id}/competitions/{id}/odds
GET .../odds/{providerId}/propBets?limit=500
```

The first lists providers (DraftKings is `100`). The second returns every prop in one page.
Each item has `type.id`, `athlete.$ref`, and `current.target.value`. The athlete id in the
`$ref` is the same id ESPN fantasy uses. The types the app reads:

| id | prop |
| --- | --- |
| 8 | passing yards |
| 12 | rushing yards |
| 13 | receiving yards |
| 14 | receptions |

Type 10 (passing touchdowns) is a threshold and is not used. Type 31 (anytime touchdown)
carries no price. Some games return 404 for odds (two of 16 in week 2), and early in the
week most games have few props.

ESPN's projected stat line for a week is the `stats` map on the projection entry
(`statSourceId` 1, `statSplitTypeId` 1). Stat ids confirmed against real projections:
3 passing yards, 4 passing TDs, 20 interceptions, 24 rushing yards, 25 rushing TDs, 42
receiving yards, 43 receiving TDs, 53 receptions, 58 targets.
