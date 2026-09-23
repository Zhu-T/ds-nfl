/**
 * Fit and check the spread model behind ceilings and win chances
 * (packages/core/src/ceiling/spread.ts).
 *
 *   npm run calibrate-ceilings                 fit on 2024, check on 2025
 *   npm run calibrate-ceilings -- 2023 2024    fit on one season, check on another
 *
 * Reads ESPN's public PPR player data (no league or credentials). For each
 * position and projection bucket in the fitting season it measures the SD and
 * the 90th percentile of (actual / projected - 1). The check scores the other
 * season: the share of player-weeks beating the ceiling (10% is right), by
 * position and bucket, and whether a player's own past booms predict beating it.
 * It prints the fitted model to paste into spread.ts.
 */

import { playersFromKona } from '../packages/adapters/src/index.js';
import { MIN_PROJECTED, spreadFor, type SpreadBucket, type SpreadModel } from '../packages/core/src/ceiling/spread.js';
import type { Position } from '../packages/core/src/types.js';

const fitSeason = Number(process.argv[2] ?? 2024);
const checkSeason = Number(process.argv[3] ?? 2025);
const WEEKS = 17;
const HOST = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons';
/** One freak game's relative miss is capped here when measuring SD. */
const CLAMP = 5;

interface Row {
  readonly id: string;
  readonly position: Position;
  readonly week: number;
  readonly actual: number;
  readonly projected: number;
}

async function season(year: number): Promise<Row[]> {
  const rows: Row[] = [];
  for (let week = 1; week <= WEEKS; week++) {
    const res = await fetch(`${HOST}/${year}/segments/0/leaguedefaults/3?view=kona_player_info&scoringPeriodId=${week}`, {
      headers: { 'x-fantasy-filter': JSON.stringify({ players: { limit: 700, sortPercOwned: { sortAsc: false, sortPriority: 1 } } }) },
    });
    if (!res.ok) throw new Error(`${year} week ${week}: HTTP ${res.status}`);
    for (const p of playersFromKona(await res.json(), week, year)) {
      if (p.actualPoints !== undefined && p.projectedPoints >= MIN_PROJECTED) {
        rows.push({ id: p.platformPlayerId, position: p.position, week, actual: p.actualPoints, projected: p.projectedPoints });
      }
    }
  }
  return rows;
}

const BOUNDS: Record<Position, number[]> = {
  QB: [12, 18, Infinity],
  RB: [6, 10, 15, Infinity],
  WR: [6, 10, 15, Infinity],
  TE: [6, 10, Infinity],
  K: [Infinity],
  DST: [Infinity],
};

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

function fitModel(rows: readonly Row[]): SpreadModel {
  const out = {} as Record<Position, SpreadBucket[]>;
  for (const [position, bounds] of Object.entries(BOUNDS) as [Position, number[]][]) {
    out[position] = bounds.map((upTo, i) => {
      const from = i === 0 ? 0 : bounds[i - 1]!;
      const misses = rows.filter((r) => r.position === position && r.projected >= from && r.projected < upTo).map((r) => r.actual / r.projected - 1);
      const clamped = misses.map((m) => Math.min(CLAMP, m));
      return {
        upTo,
        relSd: r2(Math.sqrt(clamped.reduce((s, m) => s + m * m, 0) / clamped.length)),
        relCeiling: r2(quantile(misses, 0.9)),
      };
    });
  }
  return out;
}

const [fit, check] = await Promise.all([season(fitSeason), season(checkSeason)]);
console.log(`${fitSeason}: ${fit.length} player-weeks; ${checkSeason}: ${check.length} (projected ${MIN_PROJECTED}+)\n`);
const model = fitModel(fit);

const over = (rows: readonly Row[]) => rows.filter((r) => r.actual > spreadFor(r.position, r.projected, model).ceiling).length / rows.length;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const scored = check.filter((r) => r.week >= 2);
console.log(`beat the ceiling in ${checkSeason}: ${pct(over(scored))} of ${scored.length} (target 10%)`);
for (const [position, bounds] of Object.entries(BOUNDS) as [Position, number[]][]) {
  const cells = bounds.map((upTo, i) => {
    const from = i === 0 ? 0 : bounds[i - 1]!;
    const rows = scored.filter((r) => r.position === position && r.projected >= from && r.projected < upTo);
    return `<${upTo === Infinity ? '∞' : upTo} ${pct(over(rows))} (n=${rows.length})`;
  });
  console.log(`  ${position.padEnd(4)} ${cells.join('   ')}`);
}

// Does a player's own record of beating the ceiling predict doing it again?
const past = [...fit, ...check];
const cells = scored.flatMap((r) => {
  const hist = past.filter((h) => h.id === r.id && (h.week < r.week || fit.includes(h)) && h !== r);
  if (hist.length < 6) return [];
  const boom = hist.filter((h) => h.actual > spreadFor(h.position, h.projected, model).ceiling).length / hist.length;
  return [{ boom, beat: r.actual > spreadFor(r.position, r.projected, model).ceiling }];
});
cells.sort((a, b) => a.boom - b.boom);
console.log(`\nplayers split by their own past rate of beating the ceiling (${cells.length} player-weeks with 6+ past games):`);
for (let i = 0; i < 5; i++) {
  const part = cells.slice(Math.floor((i * cells.length) / 5), Math.floor(((i + 1) * cells.length) / 5));
  const boom = part.reduce((s, c) => s + c.boom, 0) / part.length;
  console.log(`  quintile ${i + 1}: past ${pct(boom)} -> this week ${pct(part.filter((c) => c.beat).length / part.length)}`);
}

console.log(`\nfitted model:\n${JSON.stringify(model, (_, v) => (v === Infinity ? 'Infinity' : v))}`);
