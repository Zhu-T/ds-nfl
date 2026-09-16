/**
 * NFL matchups in player evaluation: whether they are on, the week's data, and
 * each player's opponent with how many points it allows to their position.
 *
 * Like betting odds, a refinement the app works without. Loading never throws;
 * when ESPN's matchup data cannot be read, projections go on without it and the
 * page says why.
 */

import 'server-only';
import { cookies } from 'next/headers';
import {
  gamesBefore,
  type EspnReader,
  type LeagueInfo,
  type LeagueRef,
  type PositionRatings,
  type ProSchedule,
  type RosterPlayer,
} from '@ds-nfl/adapters';
import type { MatchupInput, Position } from '@ds-nfl/core';
import { MATCHUP_COOKIE } from './pref-cookies';

export interface MatchupContext {
  readonly week: number;
  /** The week being played; games before it count toward a defense's sample. */
  readonly currentWeek: number;
  readonly schedule: ProSchedule;
  readonly ratings: ReadonlyMap<Position, PositionRatings>;
}

/** Safe to send to the browser. */
export interface MatchupStatus {
  readonly enabled: boolean;
  /** True when ESPN has ratings and a schedule for the week. */
  readonly available: boolean;
  readonly error: string | null;
}

export async function matchupsEnabled(): Promise<boolean> {
  return (await cookies()).get(MATCHUP_COOKIE)?.value !== 'off';
}

export async function matchupsFor(
  reader: EspnReader,
  ref: LeagueRef,
  league: LeagueInfo,
  week: number,
): Promise<{ ctx: MatchupContext | null; status: MatchupStatus }> {
  const off: MatchupStatus = { enabled: false, available: false, error: null };
  if (!(await matchupsEnabled())) return { ctx: null, status: off };
  try {
    const [schedule, ratings] = await Promise.all([reader.getProSchedule(ref), reader.getPositionalRatings(ref, week)]);
    const available = ratings.size > 0 && (schedule.weeks.get(week)?.size ?? 0) > 0;
    return {
      ctx: available ? { week, currentWeek: league.currentWeek, schedule, ratings } : null,
      status: { enabled: true, available, error: null },
    };
  } catch (error) {
    return { ctx: null, status: { ...off, enabled: true, error: error instanceof Error ? error.message : String(error) } };
  }
}

/** Each player's matchup for the week, by player id. Players on bye, or without data, are left out. */
export function matchupInputs(ctx: MatchupContext | null, players: readonly RosterPlayer[]): Map<string, MatchupInput> {
  const out = new Map<string, MatchupInput>();
  if (!ctx) return out;
  const games = ctx.schedule.weeks.get(ctx.week);
  for (const p of players) {
    const game = p.proTeam ? games?.get(p.proTeam) : undefined;
    const ratings = ctx.ratings.get(p.position);
    const rating = game ? ratings?.byOpponent.get(game.opponent) : undefined;
    if (!game || !ratings || !rating) continue;
    out.set(p.platformPlayerId, {
      opponent: game.opponent,
      home: game.home,
      allowed: rating.allowed,
      average: ratings.average,
      rank: rating.rank,
      games: gamesBefore(ctx.schedule, game.opponent, ctx.currentWeek),
    });
  }
  return out;
}
