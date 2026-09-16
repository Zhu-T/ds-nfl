/**
 * Betting-market adjustments to projections: the shape the engine carries and
 * the UI shows.
 *
 * The blend itself is computed where the league's scoring rules live
 * (adapters/espn/market.ts): for each stat the market publishes a line for,
 * ESPN's projected value and the line are averaged, and the stat line is
 * rescored under the league's own rules.
 */

export interface MarketLine {
  readonly stat: 'passing yards' | 'rushing yards' | 'receiving yards' | 'receptions';
  /** The sportsbook's over/under line. */
  readonly line: number;
  /** ESPN's projected value for the same stat. */
  readonly espn: number;
}

export interface MarketAdjustment {
  /** ESPN's projection before the blend. */
  readonly espn: number;
  /** The projection after blending in the market's lines. */
  readonly blended: number;
  readonly lines: readonly MarketLine[];
}
