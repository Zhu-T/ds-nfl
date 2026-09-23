/**
 * How widely a player's score spreads around their projection this week, and
 * their ceiling: the score they beat about one week in ten.
 *
 * Both depend only on position and projection. `npm run calibrate-ceilings`
 * fits them on ESPN's public 2024 data and checks them on 2025, and it also
 * tested using each player's own history. That did not help:
 *   - pulling toward the player's past spread made the fit worse at every
 *     weight tried (4 to 128 games of shrinkage);
 *   - players whose past games beat the ceiling most (23% of them) beat it 11.0%
 *     of the time the next week, against 9.9% for those who rarely did (1%).
 * So a "boom-prone" record is mostly noise, and the spread is the position's.
 * Two more were tested the same way (fit on 2024, scored on 2025 by the 90th
 * percentile's pinball loss): widening ceilings for a high implied team total
 * from the betting lines, and for a high coefficient of variation (SD / points
 * per game over past games). Together they improved it by 0.11%; ESPN's
 * projection already moves with the team total. Neither is used.
 *
 * The ceiling is the observed 90th percentile, not a normal approximation:
 * scores are skewed (a D/ST's especially), and a normal ceiling was beaten 16%
 * of the time for D/STs. The SD is used for win chances, where the normal
 * shape is an accepted simplification.
 */

import type { Position } from '../types.js';

/** Projections below this are backups and fringe players; their spread uses the lowest bucket. */
export const MIN_PROJECTED = 3;

export interface SpreadBucket {
  /** Applies to projections below this. */
  readonly upTo: number;
  /** SD of (actual / projected - 1). */
  readonly relSd: number;
  /** 90th percentile of (actual / projected - 1). */
  readonly relCeiling: number;
}

export type SpreadModel = Readonly<Record<Position, readonly SpreadBucket[]>>;

/**
 * Fitted on 2024 by `npm run calibrate-ceilings`; on 2025 weeks 2-17 (4,706
 * player-weeks projected 3+), the share beating the ceiling was:
 * 9.5% overall; by bucket from 3.9% (QBs projected 18+) to 12.9% (RBs 10-15),
 * K 9.6%, D/ST 11.7%. Split by each player's own past rate of beating it
 * (0.6% to 21.5%), the next week's rate stayed between 9.1% and 10.0%.
 */
export const SPREAD_MODEL: SpreadModel = {
  QB: [
    { upTo: 12, relSd: 0.75, relCeiling: 1.19 },
    { upTo: 18, relSd: 0.47, relCeiling: 0.63 },
    { upTo: Infinity, relSd: 0.42, relCeiling: 0.53 },
  ],
  RB: [
    { upTo: 6, relSd: 1.11, relCeiling: 1.54 },
    { upTo: 10, relSd: 0.78, relCeiling: 0.99 },
    { upTo: 15, relSd: 0.53, relCeiling: 0.65 },
    { upTo: Infinity, relSd: 0.45, relCeiling: 0.58 },
  ],
  WR: [
    { upTo: 6, relSd: 1.04, relCeiling: 1.23 },
    { upTo: 10, relSd: 0.8, relCeiling: 1.08 },
    { upTo: 15, relSd: 0.65, relCeiling: 0.93 },
    { upTo: Infinity, relSd: 0.51, relCeiling: 0.65 },
  ],
  TE: [
    { upTo: 6, relSd: 1.03, relCeiling: 1.25 },
    { upTo: 10, relSd: 0.79, relCeiling: 1.12 },
    { upTo: Infinity, relSd: 0.59, relCeiling: 0.76 },
  ],
  K: [{ upTo: Infinity, relSd: 0.63, relCeiling: 0.85 }],
  DST: [{ upTo: Infinity, relSd: 1.2, relCeiling: 1.63 }],
};

export interface Spread {
  /** Standard deviation of the week's score, in points. */
  readonly sd: number;
  /** The score beaten about one week in ten. */
  readonly ceiling: number;
}

export function spreadBucket(position: Position, projected: number, model: SpreadModel = SPREAD_MODEL): SpreadBucket {
  const buckets = model[position];
  return buckets.find((b) => projected < b.upTo) ?? buckets[buckets.length - 1]!;
}

/** A player's spread and ceiling this week, from their position and projection. */
export function spreadFor(position: Position, projected: number, model: SpreadModel = SPREAD_MODEL): Spread {
  const p = Math.max(0, projected);
  const b = spreadBucket(position, p, model);
  return { sd: round2(p * b.relSd), ceiling: round2(p * (1 + b.relCeiling)) };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
