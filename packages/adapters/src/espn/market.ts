/**
 * Blend the betting market into a projection.
 *
 * ESPN's projection is a stat line (yards, receptions, touchdowns...) scored
 * under the league's rules. For each stat a sportsbook publishes an over/under
 * for, ESPN's value and the line are averaged; everything else keeps ESPN's
 * value. The blended line is rescored under the same rules, so a PPR league
 * values a receptions line and a standard league ignores it.
 *
 * Only yardage and reception lines are used. A touchdown line of 1.5 is a
 * threshold, not an expectation, and ESPN publishes no anytime-touchdown
 * prices, so touchdowns stay ESPN's. Lines are the market's middle outcome;
 * yardage averages run a little higher, so the blend slightly tempers upside.
 *
 * Lines are calibrated before they are blended (`calibrateMarket`). Props are
 * posted game by game through the week and move as kickoff nears, so at any
 * moment some players are priced by the market and the rest by ESPN alone. If
 * lines as a whole sit above or below ESPN's projections, the players whose
 * props are out would be favored or penalized for that alone. Dividing each
 * line by the typical line-to-ESPN ratio for its stat and kickoff window keeps
 * only what the market says about that player relative to the others.
 */

import type { MarketAdjustment, MarketLine } from '@ds-nfl/core';
import { scoreEspnStats, type EspnScoringRules } from './scoring.js';
import type { PlayerLines } from './odds.js';

/** Share of the market line in the blend. */
export const MARKET_WEIGHT = 0.5;

/**
 * ESPN stat ids for the lines the market publishes, confirmed against ESPN's
 * own projected stat lines (3 passing yards, 24 rushing yards, 42 receiving
 * yards, 53 receptions).
 */
const MARKET_STATS: readonly { key: keyof PlayerLines; statId: string; stat: MarketLine['stat'] }[] = [
  { key: 'passYds', statId: '3', stat: 'passing yards' },
  { key: 'rushYds', statId: '24', stat: 'rushing yards' },
  { key: 'recYds', statId: '42', stat: 'receiving yards' },
  { key: 'receptions', statId: '53', stat: 'receptions' },
];

const round1 = (n: number) => Math.round(n * 10) / 10;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** ESPN stat id for each line the market publishes. */
export const MARKET_STAT_IDS: Readonly<Record<keyof PlayerLines, string>> = Object.fromEntries(
  MARKET_STATS.map((m) => [m.key, m.statId]),
) as Record<keyof PlayerLines, string>;

/** Games kicking off within this many hours have lines that have moved with the week's news; later ones may not yet. */
export const NEAR_KICKOFF_HOURS = 36;

export type KickoffWindow = 'near' | 'far';

export function kickoffWindow(kickoff: string | null | undefined, now: number = Date.now()): KickoffWindow {
  const t = kickoff ? Date.parse(kickoff) : Number.NaN;
  return Number.isFinite(t) && t - now <= NEAR_KICKOFF_HOURS * 3_600_000 ? 'near' : 'far';
}

/** One line against ESPN's projection for the same stat. */
export interface MarketSample {
  readonly key: keyof PlayerLines;
  readonly line: number;
  readonly espn: number;
  readonly window: KickoffWindow;
}

export interface MarketCalibration {
  /** What to divide a line by: the typical line-to-ESPN ratio for its stat and kickoff window. */
  readonly factor: (key: keyof PlayerLines, window: KickoffWindow) => number;
  /** Lines the calibration was measured on. */
  readonly samples: number;
}

/** Below these ESPN projections a ratio is mostly noise: a backup's 3 projected yards. */
const MIN_ESPN: Readonly<Record<keyof PlayerLines, number>> = { passYds: 100, rushYds: 15, recYds: 15, receptions: 1.5 };

/**
 * A measured median counts as much as this many lines of what it falls back
 * to: the whole week's ratio for a kickoff window, and no correction (1) for
 * the week. Early in the week, with few props posted, calibration stays mild.
 */
export const CALIBRATION_PRIOR = 12;

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function toward(values: readonly number[], fallback: number): number {
  return values.length === 0 ? fallback : (values.length * median(values) + CALIBRATION_PRIOR * fallback) / (values.length + CALIBRATION_PRIOR);
}

/** The week's typical line-to-ESPN ratio, per stat and kickoff window. */
export function calibrateMarket(samples: readonly MarketSample[]): MarketCalibration {
  const usable = samples.filter((s) => s.espn >= MIN_ESPN[s.key] && s.line > 0);
  const table = new Map<string, number>();
  for (const key of Object.keys(MIN_ESPN) as (keyof PlayerLines)[]) {
    const mine = usable.filter((s) => s.key === key);
    const week = toward(mine.map((s) => s.line / s.espn), 1);
    for (const window of ['near', 'far'] as const) {
      const ratios = mine.filter((s) => s.window === window).map((s) => s.line / s.espn);
      table.set(`${key}|${window}`, round3(toward(ratios, week)));
    }
  }
  return { factor: (key, window) => table.get(`${key}|${window}`) ?? 1, samples: usable.length };
}

/**
 * The market-blended projection, or null when there is nothing to blend: no
 * lines for the player, no ESPN stat line to blend into, or lines only for
 * stats this league does not score.
 */
export function marketAdjustment(
  player: {
    readonly projectedPoints: number;
    readonly projectedStats?: Readonly<Record<string, number>> | undefined;
    readonly positionId?: number | undefined;
  },
  lines: PlayerLines | undefined,
  rules: EspnScoringRules,
  weight: number = MARKET_WEIGHT,
  /** What to divide each line by, from `calibrateMarket`; 1 leaves lines as posted. */
  divisor: (key: keyof PlayerLines) => number = () => 1,
): MarketAdjustment | null {
  if (!lines || !player.projectedStats || player.positionId === undefined) return null;

  const blended: Record<string, number> = { ...player.projectedStats };
  const used: MarketLine[] = [];
  for (const m of MARKET_STATS) {
    const line = lines[m.key];
    if (line === undefined) continue;
    const espn = player.projectedStats[m.statId] ?? 0;
    const calibrated = line / (divisor(m.key) || 1);
    blended[m.statId] = espn * (1 - weight) + calibrated * weight;
    used.push({ stat: m.stat, line, espn: round1(espn) });
  }
  if (used.length === 0) return null;

  // Rescore both lines and apply the difference, so anything ESPN counts that
  // the market does not (bonuses, fumbles, two-point conversions) is untouched.
  const delta =
    scoreEspnStats(blended, player.positionId, rules).total -
    scoreEspnStats(player.projectedStats, player.positionId, rules).total;
  if (Math.abs(delta) < 0.05) return null;

  return {
    espn: player.projectedPoints,
    blended: round1(Math.max(0, player.projectedPoints + delta)),
    lines: used,
  };
}
