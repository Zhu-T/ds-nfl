/**
 * Recent form in player evaluation: whether it is on, and what each player has
 * actually scored this season.
 *
 * The numbers come from the same ESPN reads as the projections, so this costs
 * no extra request. A player with no games this season simply has no form.
 */

import 'server-only';
import { cookies } from 'next/headers';
import type { RosterPlayer } from '@ds-nfl/adapters';
import type { FormInput } from '@ds-nfl/core';
import { FORM_COOKIE } from './pref-cookies';

export async function formEnabled(): Promise<boolean> {
  return (await cookies()).get(FORM_COOKIE)?.value !== 'off';
}

/** Each player's scoring this season, by player id; players yet to play are left out. */
export function formInputs(players: readonly RosterPlayer[], enabled: boolean): Map<string, FormInput> {
  const out = new Map<string, FormInput>();
  if (!enabled) return out;
  for (const p of players) {
    if (typeof p.seasonAverage === 'number' && typeof p.gamesPlayed === 'number' && p.gamesPlayed > 0) {
      out.set(p.platformPlayerId, { average: p.seasonAverage, games: p.gamesPlayed });
    }
  }
  return out;
}
