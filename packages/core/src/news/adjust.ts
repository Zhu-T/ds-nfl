/**
 * Web news applied to projections.
 *
 * Findings come from a language model that searched the web, so they are
 * treated as evidence with limits rather than as numbers to trust. Each one
 * must cite pages the search actually returned (checked before it reaches the
 * engine), a status can only move a projection within a fixed range, and each
 * finding can be switched off. The optimizer then works from the adjusted
 * projections exactly as it would from the platform's.
 */

import type { OptimizerPlayer } from '../lineup/optimize.js';

export type NewsStatus = 'out' | 'doubtful' | 'questionable' | 'active';

export interface NewsSource {
  readonly url: string;
  readonly title: string;
}

export interface NewsFinding {
  readonly playerId: string;
  readonly playerName: string;
  readonly status: NewsStatus;
  /** Multiplier on the platform's projection, already bounded for the status. */
  readonly factor: number;
  readonly summary: string;
  readonly sources: readonly NewsSource[];
}

/** What a finding did to one player, kept on the player for the UI. */
export interface NewsAdjustment {
  readonly status: NewsStatus;
  /** The platform's projection before the finding. */
  readonly from: number;
  readonly factor: number;
  readonly summary: string;
}

/**
 * How far each status may move a projection.
 *
 * "Out" is certain enough to zero a player. "Doubtful" and "questionable" can
 * only lower one. A clearly bigger role ("active") can raise a projection by a
 * quarter at most, since an increase is where an over-eager reading of the
 * news would do the most damage.
 */
export const FACTOR_RANGE: Readonly<Record<NewsStatus, readonly [number, number]>> = {
  out: [0, 0],
  doubtful: [0, 0.5],
  questionable: [0.5, 1],
  active: [0.75, 1.25],
};

export function boundFactor(status: NewsStatus, factor: number): number {
  const [lo, hi] = FACTOR_RANGE[status];
  const f = Number.isFinite(factor) ? factor : hi;
  return Math.round(Math.min(hi, Math.max(lo, f)) * 100) / 100;
}

/**
 * Players with the findings applied. Players without a finding are returned
 * untouched, and so is anything the finding does not cover.
 */
export function applyNewsFindings<P extends OptimizerPlayer>(
  players: readonly P[],
  findings: readonly NewsFinding[],
): P[] {
  const byId = new Map(findings.map((f) => [f.playerId, f]));
  return players.map((p) => {
    const f = byId.get(p.gsisId);
    if (!f) return p;

    const factor = boundFactor(f.status, f.factor);
    const news: NewsAdjustment = { status: f.status, from: p.projectedPoints, factor, summary: f.summary };
    if (f.status === 'out') {
      return { ...p, available: false, unavailableReason: 'Out (news check)', projectedPoints: 0, news };
    }
    return { ...p, projectedPoints: Math.round(p.projectedPoints * factor * 10) / 10, news };
  });
}
