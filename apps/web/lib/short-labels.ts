/**
 * Compact labels for player rows, e.g. "form ×1.10" or "@ TEN ×1.13". Each
 * comes with the full wording as a tooltip, so rows stay one line without
 * losing anything. Plain functions, safe in client components.
 */

import type { FormAdjustment, MarketAdjustment, MatchupAdjustment } from '@ds-nfl/core';
import { formLabel } from './form-label';
import { matchupLabel } from './matchup-label';

export interface ShortLabel {
  readonly text: string;
  readonly title: string;
}

const pts = (n: number) => n.toFixed(1);

/** Nothing when form left the projection as it was. */
export function formShort(f: Pick<FormAdjustment, 'average' | 'games' | 'factor' | 'pricedByMarket'> | undefined): ShortLabel | null {
  if (!f || f.pricedByMarket || f.factor === 1) return null;
  return { text: `form ×${f.factor.toFixed(2)}`, title: formLabel(f) };
}

export function matchupShort(
  m: Pick<MatchupAdjustment, 'opponent' | 'home' | 'ratio' | 'factor' | 'pricedByMarket'> | undefined,
  position: string,
): ShortLabel | null {
  if (!m) return null;
  const change = m.pricedByMarket || m.factor === 1 ? '' : ` ×${m.factor.toFixed(2)}`;
  return { text: `${m.home ? 'vs' : '@'} ${m.opponent}${change}`, title: matchupLabel(m, position) };
}

export function marketShort(p: { readonly market?: MarketAdjustment | undefined }): ShortLabel | null {
  if (!p.market) return null;
  return { text: `market ${pts(p.market.blended)}`, title: `Betting-line blend ${pts(p.market.blended)}; ESPN projects ${pts(p.market.espn)}` };
}

export function gameShort(g: { readonly home: boolean; readonly opponent: string; readonly impliedPoints: number } | undefined): ShortLabel | null {
  if (!g) return null;
  return { text: `${g.home ? 'vs' : '@'} ${g.opponent}`, title: `Team expected to score ${pts(g.impliedPoints)}, from the game line` };
}
