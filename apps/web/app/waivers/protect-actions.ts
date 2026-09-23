'use server';

import { leagueKey, resolveLeague, setProtected } from '@ds-nfl/adapters';

export interface ProtectResult {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * Mark one of your players as protected, or stop protecting them.
 *
 * A protected player is never suggested as a drop and cannot be dropped to make
 * room for a pickup. It is a note to the app about your own roster, so nothing
 * is sent to ESPN.
 */
export async function setPlayerProtected(key: string, playerId: string, on: boolean): Promise<ProtectResult> {
  const league = resolveLeague(key);
  if (!league || !playerId) return { ok: false, message: 'That league is no longer connected. Reload the page.' };
  try {
    setProtected(leagueKey(league), playerId, on);
    return { ok: true, message: on ? 'Protected.' : 'No longer protected.' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
