/**
 * How a matchup reads on a player card, e.g. "@ HOU: 3rd-most pts to QBs, ×1.04".
 * Plain functions, safe in client components.
 */

import type { MatchupAdjustment } from '@ds-nfl/core';

type Shown = Pick<MatchupAdjustment, 'opponent' | 'home' | 'rank' | 'factor' | 'pricedByMarket'>;
type Described = Shown & Pick<MatchupAdjustment, 'allowed'>;

const PLURAL: Record<string, string> = { K: 'kickers', DST: 'D/STs' };

function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

/** Where the defense stands: "5th-fewest" for a tough one, "3rd-most" for an easy one (of 32). */
export function matchupPlace(rank: number): string {
  return rank <= 16 ? `${ordinal(rank)}-fewest` : `${ordinal(33 - rank)}-most`;
}

/** For a model to read: "at KC, whose defense allows 12.1 per game to RBs (rank 6 of 32, 1 = fewest), projection ×0.95". */
export function matchupSentence(m: Described, position: string): string {
  const change = m.pricedByMarket ? ', already priced by betting lines' : m.factor !== 1 ? `, projection ×${m.factor}` : '';
  return `${m.home ? 'vs' : 'at'} ${m.opponent}, whose defense allows ${m.allowed.toFixed(1)} per game to ${PLURAL[position] ?? `${position}s`} (rank ${m.rank} of 32, 1 = fewest)${change}`;
}

export function matchupLabel(m: Shown, position: string): string {
  const change = m.pricedByMarket ? ', priced by betting lines' : m.factor !== 1 ? `, ×${m.factor.toFixed(2)}` : '';
  return `${m.home ? 'vs' : '@'} ${m.opponent}: ${matchupPlace(m.rank)} pts to ${PLURAL[position] ?? `${position}s`}${change}`;
}
