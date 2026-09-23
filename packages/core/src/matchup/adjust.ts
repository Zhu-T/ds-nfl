/**
 * The NFL matchup, measured against ESPN's own projections: how players at a
 * position have scored, against their projections, when facing this opponent.
 *
 * Why against projections, and not points allowed or ESPN's opponent rank
 * (OPRK): a defense that has faced strong offenses allows more points without
 * being any weaker, and ESPN's projection already accounts for the opponent.
 * What players scored beyond their own projection is what the projections
 * missed about the opponent, with the quality of each offense already in it.
 *
 * Applied to D/STs only. A backtest on ESPN's 2024 and 2025 seasons (every
 * player-week from week 2 on, using only earlier weeks) found:
 *   - for D/STs, moving the projection toward how D/STs have done against that
 *     offense cut squared error by 1.6% (2025) and 2.5% (2024);
 *   - for every offensive position, both this measure and points allowed made
 *     ESPN's projection worse, by up to 1.8%.
 * So offensive players keep ESPN's projection; `npm run backtest-opponents`
 * reruns the test.
 */

import type { OptimizerPlayer } from '../lineup/optimize.js';
import type { Position } from '../types.js';

/** Positions whose projections the opponent moves; the backtest supports only these. */
export const MATCHUP_POSITIONS: ReadonlySet<Position> = new Set<Position>(['DST']);

export interface MatchupInput {
  /** The NFL team the player faces, e.g. "HOU". */
  readonly opponent: string;
  readonly home: boolean;
  /** Points scored against this opponent by players at the position, over what they were projected: 1.2 is 20% over. */
  readonly ratio: number;
  /** 1 is the toughest opponent (lowest ratio), up to `teams`. */
  readonly rank: number;
  readonly teams: number;
  /** Games of this opponent's the ratio covers. */
  readonly games: number;
}

export interface MatchupAdjustment extends MatchupInput {
  /** The projection before the matchup. */
  readonly from: number;
  readonly factor: number;
  /** True when betting lines already priced the opponent, so nothing changed. */
  readonly pricedByMarket: boolean;
}

/** An opponent's own record counts as much as this many games of an ordinary one. */
export const MATCHUP_SHRINK_GAMES = 4;
/** Share of the shrunk difference applied. The backtest favoured all of it for D/STs. */
export const MATCHUP_WEIGHT = 1;
/** Largest change either way. */
export const MATCHUP_LIMIT = 0.2;

/**
 * The multiplier for a matchup. After one game, D/STs that scored 50% over
 * their projections against an offense move the next projection 10%. With no
 * games it is 1.
 */
export function matchupFactor(ratio: number, games: number): number {
  if (!(games > 0) || !Number.isFinite(ratio)) return 1;
  const shrunk = (ratio - 1) * (games / (games + MATCHUP_SHRINK_GAMES));
  const factor = Math.min(1 + MATCHUP_LIMIT, Math.max(1 - MATCHUP_LIMIT, 1 + shrunk * MATCHUP_WEIGHT));
  return Math.round(factor * 1000) / 1000;
}

/** One player's game: what they scored and were projected, and whom they faced. */
export interface OpponentGame {
  readonly week: number;
  readonly position: Position;
  readonly opponent: string;
  readonly actual: number;
  readonly projected: number;
}

export interface OpponentSplit {
  readonly ratio: number;
  readonly rank: number;
  readonly teams: number;
  readonly games: number;
}

/**
 * Each opponent's record by position: points scored against it over points
 * projected, pooled across its games, ranked from toughest. Players projected
 * for less than a point are left out, as they barely played.
 */
export function opponentSplits(games: readonly OpponentGame[]): Map<Position, Map<string, OpponentSplit>> {
  const sums = new Map<Position, Map<string, { actual: number; projected: number; weeks: Set<number> }>>();
  for (const g of games) {
    if (!(g.projected >= 1) || !Number.isFinite(g.actual)) continue;
    const byTeam = sums.get(g.position) ?? new Map();
    sums.set(g.position, byTeam);
    const s = byTeam.get(g.opponent) ?? { actual: 0, projected: 0, weeks: new Set<number>() };
    byTeam.set(g.opponent, s);
    s.actual += g.actual;
    s.projected += g.projected;
    s.weeks.add(g.week);
  }
  const out = new Map<Position, Map<string, OpponentSplit>>();
  for (const [position, byTeam] of sums) {
    const ratios = [...byTeam].map(([team, s]) => ({ team, ratio: Math.round((s.actual / s.projected) * 1000) / 1000, games: s.weeks.size }));
    ratios.sort((a, b) => a.ratio - b.ratio || a.team.localeCompare(b.team));
    out.set(position, new Map(ratios.map((r, i) => [r.team, { ratio: r.ratio, rank: i + 1, teams: ratios.length, games: r.games }])));
  }
  return out;
}

/**
 * Players with their matchup applied. Players without one are returned
 * untouched; a player the market priced keeps their projection and is marked so.
 */
export function applyMatchups<P extends OptimizerPlayer>(
  players: readonly P[],
  byId: ReadonlyMap<string, MatchupInput>,
): P[] {
  return players.map((p) => {
    const input = byId.get(p.gsisId);
    if (!input) return p;
    const pricedByMarket = p.market !== undefined;
    const factor = pricedByMarket ? 1 : matchupFactor(input.ratio, input.games);
    const matchup: MatchupAdjustment = { ...input, from: p.projectedPoints, factor, pricedByMarket };
    const projectedPoints = factor === 1 ? p.projectedPoints : Math.round(p.projectedPoints * factor * 10) / 10;
    return { ...p, projectedPoints, matchup };
  });
}
