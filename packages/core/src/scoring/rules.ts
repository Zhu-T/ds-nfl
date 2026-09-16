/**
 * League scoring, modelled completely.
 *
 * The previous implementation reduced an entire league's scoring to a single
 * question — "is statId 53 (receptions) worth a point?" — and discarded passing
 * TD values, 4pt-vs-6pt, yardage bonuses, and every D/ST rule. Every number
 * downstream (projections, VORP, lineup decisions, trade deltas) is denominated
 * in league points, so this file is the precondition for all of it.
 */

import type { Position } from '../types.js';

/**
 * Canonical stat vocabulary. Platform stat ids and nflverse column names are
 * both translated into these keys at their respective boundaries.
 */
export const STAT_KEYS = [
  // passing
  'passYds', 'passTd', 'passInt', 'passCmp', 'passAtt', 'passIncomplete',
  'pass2pt', 'passFirstDown', 'passSacked',
  // rushing
  'rushYds', 'rushTd', 'rushAtt', 'rush2pt', 'rushFirstDown',
  // receiving
  'rec', 'recYds', 'recTd', 'rec2pt', 'recFirstDown', 'targets',
  // turnovers
  'fumblesLost', 'fumbleRecTd',
  // kicking
  'fgMade0_19', 'fgMade20_29', 'fgMade30_39', 'fgMade40_49', 'fgMade50_59', 'fgMade60Plus',
  'fgMissed', 'patMade', 'patMissed',
  // defense / special teams
  'dstSack', 'dstInt', 'dstFumRec', 'dstTd', 'dstSafety', 'dstBlockedKick',
  'dstReturnTd', 'dstPointsAllowed', 'dstYardsAllowed',
] as const;

export type StatKey = (typeof STAT_KEYS)[number];

/** A single player-week of production. Absent keys are treated as zero. */
export type StatLine = Partial<Record<StatKey, number>>;

/**
 * The four rule shapes every platform's scoring reduces to.
 *
 * `positions` scopes a rule to certain positions — ESPN expresses this as
 * `pointsOverrides` keyed by player `defaultPositionId`, Sleeper as `bonus_rec_te`
 * and friends. TE-premium leagues are the common case.
 */
export type ScoringRule =
  /** Points per single unit. Yardage is the usual case: 0.04 => 1pt per 25 yards. */
  | { kind: 'perUnit'; stat: StatKey; points: number; positions?: readonly Position[] }
  /** Points per N units, optionally only for completed blocks of N. */
  | {
      kind: 'perN';
      stat: StatKey;
      points: number;
      per: number;
      rounding: 'floor' | 'exact';
      positions?: readonly Position[];
    }
  /** Flat award once a stat reaches a threshold — the 100-yard-game bonus. */
  | { kind: 'threshold'; stat: StatKey; points: number; atLeast: number; positions?: readonly Position[] }
  /**
   * Banded award. D/ST points-allowed and yards-allowed are the reason this
   * exists. Bands are evaluated in order; `max: null` is the open-ended top band.
   */
  | {
      kind: 'bucket';
      stat: StatKey;
      bands: readonly { max: number | null; points: number }[];
      positions?: readonly Position[];
    };

export interface ScoringRuleSet {
  readonly rules: readonly ScoringRule[];
  /**
   * Platform scoring items we could not map to a `StatKey`.
   *
   * These are surfaced in the UI rather than silently dropped: an unmapped rule
   * means our computed points disagree with the platform's, and the user needs
   * to know that before trusting a start/sit call.
   */
  readonly unmapped: readonly { platformStatId: string; points: number; note: string }[];
  readonly source: { platform: string; fetchedAt: number };
}

export interface ScorePart {
  readonly stat: StatKey;
  readonly value: number;
  readonly points: number;
}

export interface ScoreBreakdown {
  readonly total: number;
  /** Per-rule contributions, for rendering "why is he projected for 14.2?". */
  readonly parts: readonly ScorePart[];
}

/** Fantasy points are conventionally reported to two decimals. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function ruleApplies(rule: ScoringRule, position: Position): boolean {
  return rule.positions === undefined || rule.positions.includes(position);
}

function pointsFor(rule: ScoringRule, value: number): number {
  switch (rule.kind) {
    case 'perUnit':
      return value * rule.points;
    case 'perN': {
      const blocks = rule.rounding === 'floor' ? Math.floor(value / rule.per) : value / rule.per;
      return blocks * rule.points;
    }
    case 'threshold':
      return value >= rule.atLeast ? rule.points : 0;
    case 'bucket': {
      const band = rule.bands.find((b) => b.max === null || value <= b.max);
      return band?.points ?? 0;
    }
  }
}

/**
 * Apply a league's rules to one stat line.
 *
 * Returns the breakdown as well as the total — the UI renders it, and the LLM
 * layer cites it rather than recomputing (and potentially fabricating) numbers.
 */
export function scoreStatLine(
  line: StatLine,
  position: Position,
  ruleSet: ScoringRuleSet,
): ScoreBreakdown {
  const parts: ScorePart[] = [];
  let total = 0;

  for (const rule of ruleSet.rules) {
    if (!ruleApplies(rule, position)) continue;

    const value = line[rule.stat] ?? 0;
    // A bucket rule still scores at value 0 (a shutout is the best D/ST band),
    // so it must be evaluated even when the stat is absent.
    if (value === 0 && rule.kind !== 'bucket') continue;

    const points = pointsFor(rule, value);
    if (points !== 0) parts.push({ stat: rule.stat, value, points: round2(points) });
    total += points;
  }

  return { total: round2(total), parts };
}
