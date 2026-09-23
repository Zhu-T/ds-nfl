/**
 * Your chance of winning the week's matchup, and the lineup that maximises it.
 *
 * Each starter's score is taken as independent and normal: the projection with
 * the position's spread (see spread.ts) for a game not yet played, what they
 * scored for a finished game, and in between for a game in progress. A team's
 * total is then normal too, and
 *   P(win) = Φ((your mean − their mean) / √(your variance + their variance)).
 * Independence understates a quarterback and his own receiver booming
 * together; the normal shape understates long tails. Both are said in the app.
 *
 * Maximising the win chance is not the same as maximising points: far behind,
 * spread helps; well ahead, it hurts. The exact lineup optimizer only maximises
 * a sum, so it is run on mean + λ·sd for a range of λ, and the lineup with the
 * best win chance is kept. λ = 0 is the best-projected lineup, so the result is
 * never worse than it.
 */

import { optimizeLineup, type LineupSolution, type OptimizerPlayer } from '../lineup/optimize.js';
import type { RosterSettings } from '../types.js';
import { spreadFor } from './spread.js';

/** Where a player's game stands. */
export type GameState = 'upcoming' | 'live' | 'final';

/** A score as a mean and a spread. */
export interface WeekOutlook {
  readonly mean: number;
  readonly sd: number;
}

export interface Distribution {
  readonly mean: number;
  readonly variance: number;
}

/**
 * A player's week as a distribution: what they scored once their game is final;
 * during it, the larger of their score so far and their projection, with half the
 * spread; before it, their projection with the full spread.
 */
export function outlookOf(p: OptimizerPlayer, state: GameState, actual?: number): WeekOutlook {
  if (state === 'final') return { mean: actual ?? 0, sd: 0 };
  const { sd } = spreadFor(p.position, p.projectedPoints);
  if (state === 'live') return { mean: Math.max(actual ?? 0, p.projectedPoints), sd: sd / 2 };
  return { mean: p.projectedPoints, sd };
}

export function lineupDistribution(starters: readonly OptimizerPlayer[], outlook: (p: OptimizerPlayer) => WeekOutlook): Distribution {
  let mean = 0;
  let variance = 0;
  for (const p of starters) {
    const o = outlook(p);
    mean += o.mean;
    variance += o.sd * o.sd;
  }
  return { mean, variance };
}

/** The standard normal CDF (Abramowitz and Stegun 7.1.26; error below 1.5e-7). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(x) / Math.SQRT2));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** The chance your total beats theirs; ties in a certain outcome count as half. */
export function winChance(mine: Distribution, theirs: Distribution): number {
  const diff = mine.mean - theirs.mean;
  const variance = mine.variance + theirs.variance;
  if (variance <= 0) return diff > 0 ? 1 : diff < 0 ? 0 : 0.5;
  return normalCdf(diff / Math.sqrt(variance));
}

/** Weights on spread tried; negative ones favour steady players when ahead. */
export const SPREAD_WEIGHTS = [-1, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, 1.5, 2] as const;

export interface WinLineup {
  readonly solution: LineupSolution;
  readonly distribution: Distribution;
  readonly chance: number;
  /** The spread weight that found it; 0 is the best-projected lineup. */
  readonly weight: number;
}

const startersOf = (s: LineupSolution) => s.starters.flatMap((a) => (a.player ? [a.player] : []));

/** The lineup with the best chance of beating `opponent`, and that chance. */
export function bestWinLineup(
  roster: readonly OptimizerPlayer[],
  settings: RosterSettings,
  outlook: (p: OptimizerPlayer) => WeekOutlook,
  opponent: Distribution,
): WinLineup {
  const byId = new Map(roster.map((p) => [p.gsisId, p]));
  let best: WinLineup | null = null;
  for (const weight of SPREAD_WEIGHTS) {
    const weighted = roster.map((p) => {
      const o = outlook(p);
      return { ...p, projectedPoints: o.mean + weight * o.sd };
    });
    const picked = optimizeLineup(weighted, settings);
    // Back to the real players, so totals and labels are unweighted.
    const solution: LineupSolution = {
      starters: picked.starters.map((a) => ({ ...a, player: a.player ? byId.get(a.player.gsisId)! : null })),
      bench: picked.bench.map((p) => byId.get(p.gsisId)!),
      projectedPoints: 0,
    };
    const distribution = lineupDistribution(startersOf(solution), outlook);
    const chance = winChance(distribution, opponent);
    // Only a real improvement moves off the best-projected lineup.
    if (!best || chance > best.chance + 1e-9 || (weight === 0 && chance >= best.chance - 1e-9)) {
      best = { solution: { ...solution, projectedPoints: round1(distribution.mean) }, distribution, chance, weight };
    }
  }
  return best!;
}

export interface WinCandidate {
  readonly player: OptimizerPlayer;
  /** Win chance with your roster as it is, and with this player added (best lineup each way). */
  readonly before: number;
  readonly after: number;
  readonly gain: number;
  readonly ceiling: number;
  /** The starter they would replace in the win-chance lineup, if any. */
  readonly displaces: string | null;
}

/**
 * Pickups ranked by how much each raises your chance of winning this week. Only
 * players whose game has not started can help, so the caller passes only those.
 */
export function rankForWinChance(
  roster: readonly OptimizerPlayer[],
  candidates: readonly OptimizerPlayer[],
  settings: RosterSettings,
  outlook: (p: OptimizerPlayer) => WeekOutlook,
  opponent: Distribution,
): { base: WinLineup; ranked: WinCandidate[] } {
  const base = bestWinLineup(roster, settings, outlook, opponent);
  const baseStarters = new Set(startersOf(base.solution).map((p) => p.gsisId));
  const ranked = candidates.map((player) => {
    const withThem = bestWinLineup([...roster, player], settings, outlook, opponent);
    const now = new Set(startersOf(withThem.solution).map((p) => p.gsisId));
    const out = [...baseStarters].find((id) => !now.has(id));
    return {
      player,
      before: base.chance,
      after: withThem.chance,
      gain: withThem.chance - base.chance,
      ceiling: spreadFor(player.position, player.projectedPoints).ceiling,
      displaces: out ? (roster.find((p) => p.gsisId === out)?.name ?? null) : null,
    };
  });
  ranked.sort((a, b) => b.gain - a.gain || b.ceiling - a.ceiling);
  return { base, ranked };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
