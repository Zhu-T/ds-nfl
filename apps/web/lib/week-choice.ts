/**
 * Which week the app is showing: the one being played, or the next one.
 *
 * Kept in a cookie so every page and the League AI agree without threading a
 * parameter through every link. It is relative on purpose: "next" means week 3
 * once week 2 is being played.
 */

import 'server-only';
import { cookies } from 'next/headers';
import { clampWeek, planningWeek, type WeekChoice } from '@ds-nfl/core';
import type { LeagueInfo } from '@ds-nfl/adapters';
import { WEEK_COOKIE } from './pref-cookies';

export async function weekChoice(): Promise<WeekChoice> {
  return (await cookies()).get(WEEK_COOKIE)?.value === 'next' ? 'next' : 'this';
}

/**
 * The week a request is about: the one an action names, kept within the season
 * and never before the week being played, or else the one the switch points at.
 */
export async function resolveWeek(league: LeagueInfo, requested?: number | null): Promise<number> {
  if (typeof requested === 'number' && requested > 0) {
    return clampWeek(requested, league.currentWeek, league.finalWeek);
  }
  return planningWeek(await weekChoice(), league.currentWeek, league.finalWeek);
}
