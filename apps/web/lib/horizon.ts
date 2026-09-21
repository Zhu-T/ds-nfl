/**
 * The coming weeks a pickup or a drop is valued across: the week shown and up
 * to three after it, within the fantasy season, with each player's
 * rest-of-season rate and the weeks their NFL team is on bye.
 */

import type { EspnReader, LeagueInfo, LeagueRef, RosterPlayer } from '@ds-nfl/adapters';
import type { Horizon, Outlook } from '@ds-nfl/core';

/** Weeks valued, the one shown included. */
export const HORIZON_WEEKS = 4;

/**
 * Without the NFL schedule no byes are known and every week counts; a player
 * with no rest-of-season projection keeps this week's.
 */
export async function horizonFor(
  reader: EspnReader,
  ref: LeagueRef,
  league: LeagueInfo,
  week: number,
  players: readonly RosterPlayer[],
): Promise<Horizon> {
  const last = Math.max(week, Math.min(league.finalWeek, week + HORIZON_WEEKS - 1));
  const weeks = Array.from({ length: last - week + 1 }, (_, i) => week + i);
  const schedule = await reader.getProSchedule(ref).catch(() => null);
  const outlooks = new Map<string, Outlook>();
  for (const p of players) {
    const offWeeks = new Set(
      weeks.filter((w) => {
        const games = schedule?.weeks.get(w);
        return Boolean(p.proTeam && p.proTeam !== 'FA' && games && games.size > 0 && !games.has(p.proTeam));
      }),
    );
    outlooks.set(p.platformPlayerId, { perGame: p.restOfSeasonAverage ?? p.projectedPoints, offWeeks });
  }
  return { weeks, outlooks };
}
