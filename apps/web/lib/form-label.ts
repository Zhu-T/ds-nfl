/**
 * How recent form reads on a player card, e.g. "form: 30.1 a game over 1 game,
 * ×1.10". Plain functions, safe in client components.
 */

import type { FormAdjustment } from '@ds-nfl/core';

/** What a label shows: the pre-form projection is not needed. */
type Shown = Pick<FormAdjustment, 'average' | 'games' | 'factor' | 'pricedByMarket'>;

const pts = (n: number) => n.toFixed(1);
const games = (n: number) => `${n} ${n === 1 ? 'game' : 'games'}`;

export function formLabel(f: Shown): string {
  const change = f.pricedByMarket ? ', priced by betting lines' : f.factor !== 1 ? `, ×${f.factor.toFixed(2)}` : '';
  return `form: ${pts(f.average)} a game over ${games(f.games)}${change}`;
}

/** For a model to read: "has scored 30.1 per game over 1 game this season, projection ×1.096". */
export function formSentence(f: Shown): string {
  const change = f.pricedByMarket
    ? ', already priced by betting lines'
    : f.factor !== 1
      ? `, projection ×${f.factor}`
      : '';
  return `has scored ${pts(f.average)} per game over ${games(f.games)} this season${change}`;
}
