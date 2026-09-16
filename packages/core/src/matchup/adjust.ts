/**
 * The NFL matchup: how many fantasy points a player's opponent allows to their
 * position, as a small, bounded change to the projection.
 *
 * ESPN's weekly projection is already made for the specific game, so this is
 * deliberately cautious, to avoid counting the opponent twice:
 *   - early in a season a defense's average rests on a game or two, so it is
 *     pulled toward the league average until the defense has several games
 *     behind it;
 *   - only half of what remains is applied;
 *   - the change is capped at 10% either way;
 *   - a player whose projection already blends in betting lines is left as it
 *     is, because the market has priced the opponent.
 */

import type { OptimizerPlayer } from '../lineup/optimize.js';

export interface MatchupInput {
  /** The NFL team the player faces, e.g. "HOU". */
  readonly opponent: string;
  readonly home: boolean;
  /** Fantasy points per game the opponent allows to this position this season. */
  readonly allowed: number;
  /** The average allowed to this position across the league. */
  readonly average: number;
  /** 1 allows the fewest points (the toughest matchup), 32 the most. */
  readonly rank: number;
  /** Games the opponent has played this season. */
  readonly games: number;
}

export interface MatchupAdjustment extends MatchupInput {
  /** The projection before the matchup. */
  readonly from: number;
  readonly factor: number;
  /** True when betting lines already priced the opponent, so nothing changed. */
  readonly pricedByMarket: boolean;
}

/** A defense's own average counts as much as this many games of league average. */
export const MATCHUP_SHRINK_GAMES = 4;
/** Share of the remaining difference applied, since ESPN's projection already reflects the matchup. */
export const MATCHUP_WEIGHT = 0.5;
/** Largest change either way. */
export const MATCHUP_LIMIT = 0.1;

/**
 * The multiplier for a matchup. After one game a defense that allows double
 * the average moves a projection by about 10%; an ordinary difference, by 1 to
 * 3%. With no games or no average it is 1.
 */
export function matchupFactor(allowed: number, average: number, games: number): number {
  if (!(average > 0) || !(games > 0) || !Number.isFinite(allowed)) return 1;
  const shrunk = (allowed / average - 1) * (games / (games + MATCHUP_SHRINK_GAMES));
  const factor = Math.min(1 + MATCHUP_LIMIT, Math.max(1 - MATCHUP_LIMIT, 1 + shrunk * MATCHUP_WEIGHT));
  return Math.round(factor * 1000) / 1000;
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
    const factor = pricedByMarket ? 1 : matchupFactor(input.allowed, input.average, input.games);
    const matchup: MatchupAdjustment = { ...input, from: p.projectedPoints, factor, pricedByMarket };
    const projectedPoints = factor === 1 ? p.projectedPoints : Math.round(p.projectedPoints * factor * 10) / 10;
    return { ...p, projectedPoints, matchup };
  });
}
