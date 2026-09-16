/**
 * Recent form: how a player has actually scored this season, against what they
 * are projected for this week.
 *
 * A projection is an average expectation; it is slow to follow a player whose
 * role or play has changed. Their own results are the check on it. As with the
 * NFL matchup, ESPN's projection already reflects some of this, so the
 * adjustment is deliberately cautious:
 *   - a season of one or two games is mostly noise, so the player's average is
 *     pulled toward their projection until several games are behind it;
 *   - only half of what remains is applied;
 *   - the change is capped at 10% either way;
 *   - a player whose projection already blends in betting lines is left alone,
 *     because the market prices form far better than this can.
 */

import type { OptimizerPlayer } from '../lineup/optimize.js';

export interface FormInput {
  /** Fantasy points per game actually scored this season, under this league's scoring. */
  readonly average: number;
  /** Games played this season. */
  readonly games: number;
}

export interface FormAdjustment extends FormInput {
  /** The projection before form. */
  readonly from: number;
  readonly factor: number;
  /** True when betting lines already priced the player, so nothing changed. */
  readonly pricedByMarket: boolean;
}

/** A player's own games count as much as this many games of their projection. */
export const FORM_SHRINK_GAMES = 3;
/** Share of the remaining difference applied, since the projection already reflects some of it. */
export const FORM_WEIGHT = 0.5;
/** Largest change either way. */
export const FORM_LIMIT = 0.1;

/**
 * The multiplier for recent form. After one game, a player averaging double
 * their projection gains about 10%; an ordinary difference, 1 to 3%. With no
 * games played, or nothing projected, it is 1.
 */
export function formFactor(average: number, projected: number, games: number): number {
  if (!(projected > 0) || !(games > 0) || !Number.isFinite(average)) return 1;
  const shrunk = (average / projected - 1) * (games / (games + FORM_SHRINK_GAMES));
  const factor = Math.min(1 + FORM_LIMIT, Math.max(1 - FORM_LIMIT, 1 + shrunk * FORM_WEIGHT));
  return Math.round(factor * 1000) / 1000;
}

/**
 * Players with their form applied. Players with no games this season are
 * returned untouched; a player the market priced keeps their projection and is
 * marked so.
 */
export function applyForm<P extends OptimizerPlayer>(players: readonly P[], byId: ReadonlyMap<string, FormInput>): P[] {
  return players.map((p) => {
    const input = byId.get(p.gsisId);
    if (!input || input.games <= 0) return p;
    const pricedByMarket = p.market !== undefined;
    const factor = pricedByMarket ? 1 : formFactor(input.average, p.projectedPoints, input.games);
    const form: FormAdjustment = { ...input, from: p.projectedPoints, factor, pricedByMarket };
    const projectedPoints = factor === 1 ? p.projectedPoints : Math.round(p.projectedPoints * factor * 10) / 10;
    return { ...p, projectedPoints, form };
  });
}
