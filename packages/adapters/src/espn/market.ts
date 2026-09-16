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
): MarketAdjustment | null {
  if (!lines || !player.projectedStats || player.positionId === undefined) return null;

  const blended: Record<string, number> = { ...player.projectedStats };
  const used: MarketLine[] = [];
  for (const m of MARKET_STATS) {
    const line = lines[m.key];
    if (line === undefined) continue;
    const espn = player.projectedStats[m.statId] ?? 0;
    blended[m.statId] = espn * (1 - weight) + line * weight;
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
