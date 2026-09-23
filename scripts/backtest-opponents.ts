/**
 * Does adjusting ESPN's weekly projection for the opponent make it more accurate?
 *
 *   npm run backtest-opponents                 2025, weeks 1-17
 *   npm run backtest-opponents -- 2024 17      another season, up to a week
 *
 * Reads ESPN's public PPR player data (no league or credentials needed). Every
 * player-week from week 2 on is projected three ways, using only earlier weeks:
 *   - ESPN's projection as is;
 *   - moved toward how players at the position have scored against that
 *     opponent, relative to their projections (the app's model);
 *   - moved toward the points that opponent allows to the position against the
 *     league average (what ESPN's opponent rank, OPRK, measures).
 * It prints the change in squared error, overall and by position; negative is better.
 *
 * Results that set the app's model (packages/core/src/matchup/adjust.ts):
 *   2025: vs projection, all positions +0.16%, D/ST -1.59% (full weight, 20% cap); points allowed +1.00%
 *   2024: vs projection, all positions +0.21%, D/ST -2.53% (full weight, 20% cap); points allowed +0.50%
 */

import { parseProSchedule, playersFromKona } from '../packages/adapters/src/index.js';

const season = Number(process.argv[2] ?? 2025);
const lastWeek = Number(process.argv[3] ?? 17);
const HOST = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons';

interface Row {
  readonly week: number;
  readonly pos: string;
  readonly opp: string;
  readonly actual: number;
  readonly projected: number;
}

async function json(url: string, filter?: object): Promise<any> {
  const res = await fetch(url, filter ? { headers: { 'x-fantasy-filter': JSON.stringify(filter) } } : {});
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

const schedule = parseProSchedule(await json(`${HOST}/${season}?view=proTeamSchedules_wl`));
const rows: Row[] = [];
for (let w = 1; w <= lastWeek; w++) {
  const data = await json(`${HOST}/${season}/segments/0/leaguedefaults/3?view=kona_player_info&scoringPeriodId=${w}`, {
    players: { limit: 700, sortPercOwned: { sortAsc: false, sortPriority: 1 } },
  });
  for (const p of playersFromKona(data, w, season)) {
    const game = p.proTeam ? schedule.weeks.get(w)?.get(p.proTeam) : undefined;
    if (game && p.actualPoints !== undefined && p.projectedPoints >= 1) {
      rows.push({ week: w, pos: p.position, opp: game.opponent, actual: p.actualPoints, projected: p.projectedPoints });
    }
  }
}
console.log(`${season}: ${rows.length} player-games in weeks 1-${lastWeek}\n`);

type Signal = (past: readonly Row[], row: Row) => { value: number; games: number } | null;

/** How players at the position scored against this opponent, over their projections. */
const vsProjection: Signal = (past, row) => {
  const games = past.filter((r) => r.pos === row.pos && r.opp === row.opp);
  const projected = games.reduce((s, r) => s + r.projected, 0);
  return projected > 0 ? { value: games.reduce((s, r) => s + r.actual, 0) / projected, games: new Set(games.map((r) => r.week)).size } : null;
};

/** Points allowed to the position per game, against the league average. */
const pointsAllowed: Signal = (past, row) => {
  const atPos = past.filter((r) => r.pos === row.pos);
  const perTeam = new Map<string, { pts: number; weeks: Set<number> }>();
  for (const r of atPos) {
    const t = perTeam.get(r.opp) ?? { pts: 0, weeks: new Set<number>() };
    t.pts += r.actual;
    t.weeks.add(r.week);
    perTeam.set(r.opp, t);
  }
  const mine = perTeam.get(row.opp);
  const perGame = [...perTeam.values()].map((t) => t.pts / t.weeks.size);
  const average = perGame.reduce((s, x) => s + x, 0) / perGame.length;
  return mine && average > 0 ? { value: mine.pts / mine.weeks.size / average, games: mine.weeks.size } : null;
};

function score(signal: Signal, shrinkGames: number, weight: number, cap: number, only?: string) {
  const total = { base: 0, adjusted: 0 };
  const byPos = new Map<string, { base: number; adjusted: number }>();
  for (let w = 2; w <= lastWeek; w++) {
    const past = rows.filter((r) => r.week < w);
    for (const row of rows.filter((r) => r.week === w && (!only || r.pos === only))) {
      const s = signal(past, row);
      const factor = s ? Math.min(1 + cap, Math.max(1 - cap, 1 + (s.value - 1) * (s.games / (s.games + shrinkGames)) * weight)) : 1;
      const base = (row.actual - row.projected) ** 2;
      const adjusted = (row.actual - row.projected * factor) ** 2;
      total.base += base;
      total.adjusted += adjusted;
      const p = byPos.get(row.pos) ?? { base: 0, adjusted: 0 };
      p.base += base;
      p.adjusted += adjusted;
      byPos.set(row.pos, p);
    }
  }
  const pct = (x: { base: number; adjusted: number }) => `${x.adjusted >= x.base ? '+' : ''}${((x.adjusted / x.base - 1) * 100).toFixed(2)}%`;
  return `${pct(total)}   ${[...byPos].map(([pos, x]) => `${pos} ${pct(x)}`).join('  ')}`;
}

console.log('Squared error against ESPN as is (negative is better)');
console.log(`vs projection,  all positions, half weight, 10% cap:  ${score(vsProjection, 4, 0.5, 0.1)}`);
console.log(`points allowed, all positions, half weight, 10% cap:  ${score(pointsAllowed, 4, 0.5, 0.1)}`);
console.log(`vs projection,  D/ST only,     full weight, 20% cap:  ${score(vsProjection, 4, 1, 0.2, 'DST')}  <- the app`);
