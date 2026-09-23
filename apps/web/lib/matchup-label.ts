/**
 * How a matchup reads on a player card, e.g. "@ HOU: D/STs 24% over projection vs them, ×1.05".
 * Plain functions, safe in client components.
 */

import type { MatchupAdjustment } from '@ds-nfl/core';

type Shown = Pick<MatchupAdjustment, 'opponent' | 'home' | 'ratio' | 'factor' | 'pricedByMarket'>;
type Described = Shown & Pick<MatchupAdjustment, 'rank' | 'teams' | 'games'>;

const PLURAL: Record<string, string> = { K: 'kickers', DST: 'D/STs' };
const plural = (position: string) => PLURAL[position] ?? `${position}s`;

/** "24% over projection" or "30% under projection". */
export function versusProjection(ratio: number): string {
  const pct = Math.round(Math.abs(ratio - 1) * 100);
  return pct === 0 ? 'as projected' : `${pct}% ${ratio > 1 ? 'over' : 'under'} projection`;
}

const games = (n: number) => `${n} game${n === 1 ? '' : 's'}`;

/** For a model to read: "at HOU; D/STs have scored 24% over projection against them over 1 game (rank 28 of 32, 1 = toughest), projection ×1.05". */
export function matchupSentence(m: Described, position: string): string {
  const change = m.pricedByMarket ? ', already priced by betting lines' : m.factor !== 1 ? `, projection ×${m.factor}` : '';
  return `${m.home ? 'vs' : 'at'} ${m.opponent}; ${plural(position)} have scored ${versusProjection(m.ratio)} against them over ${games(m.games)} (rank ${m.rank} of ${m.teams}, 1 = toughest)${change}`;
}

export function matchupLabel(m: Shown, position: string): string {
  const change = m.pricedByMarket ? ', priced by betting lines' : m.factor !== 1 ? `, ×${m.factor.toFixed(2)}` : '';
  return `${m.home ? 'vs' : '@'} ${m.opponent}: ${plural(position)} ${versusProjection(m.ratio)} vs them${change}`;
}
