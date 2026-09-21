/**
 * How betting lines read on a player row, e.g. "market 12.7 · ESPN 11.8".
 * Empty when no lines were blended into the player's projection.
 */

import type { MarketAdjustment } from '@ds-nfl/core';

const pts = (n: number) => n.toFixed(1);

export function marketLabel(p: { readonly market?: MarketAdjustment | undefined }): string {
  return p.market ? `market ${pts(p.market.blended)} · ESPN ${pts(p.market.espn)}` : '';
}
