/**
 * NFL matchups in player evaluation: whether they are on, the week's data, and
 * each D/ST's opponent with how D/STs have scored against it, over their
 * projections. See packages/core/src/matchup/adjust.ts for why only D/STs, and
 * why not ESPN's opponent ranks.
 *
 * Like betting odds, a refinement the app works without. Loading never throws;
 * when the data cannot be read, projections go on without it and the page says why.
 */

import 'server-only';
import { cookies } from 'next/headers';
import { opponentGames, type EspnReader, type LeagueInfo, type LeagueRef, type ProSchedule, type RosterPlayer } from '@ds-nfl/adapters';
import { MATCHUP_POSITIONS, opponentSplits, type MatchupInput, type OpponentSplit, type Position } from '@ds-nfl/core';
import { MATCHUP_COOKIE } from './pref-cookies';

export interface MatchupContext {
  readonly week: number;
  readonly schedule: ProSchedule;
  /** By position, then opponent: how players at the position have scored against it, over their projections. */
  readonly splits: ReadonlyMap<Position, ReadonlyMap<string, OpponentSplit>>;
}

/** Safe to send to the browser. */
export interface MatchupStatus {
  readonly enabled: boolean;
  /** True when at least one week has been played to measure opponents by. */
  readonly available: boolean;
  readonly error: string | null;
}

export async function matchupsEnabled(): Promise<boolean> {
  return (await cookies()).get(MATCHUP_COOKIE)?.value !== 'off';
}

/** Finished weeks never change, so each is read once per league and season. */
const weekCache = new Map<string, Promise<readonly RosterPlayer[]>>();

function defenseWeek(reader: EspnReader, ref: LeagueRef, week: number): Promise<readonly RosterPlayer[]> {
  const key = `${ref.leagueId}:${ref.season}:${week}`;
  const hit = weekCache.get(key);
  if (hit) return hit;
  const read = reader.getDefenseWeek(ref, week);
  weekCache.set(key, read);
  read.catch(() => weekCache.delete(key));
  return read;
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
    // Only weeks already over: a week in progress would count half-played games.
    const finished = Array.from({ length: Math.max(0, league.currentWeek - 1) }, (_, i) => i + 1);
    const [schedule, ...played] = await Promise.all([reader.getProSchedule(ref), ...finished.map((w) => defenseWeek(reader, ref, w))]);
    const splits = opponentSplits(opponentGames(schedule, new Map(finished.map((w, i) => [w, played[i]!]))));
    const available = splits.size > 0 && (schedule.weeks.get(week)?.size ?? 0) > 0;
    return {
      ctx: available ? { week, schedule, splits } : null,
      status: { enabled: true, available, error: null },
    };
  } catch (error) {
    return { ctx: null, status: { ...off, enabled: true, error: error instanceof Error ? error.message : String(error) } };
  }
}

/** Each D/ST's matchup for the week, by player id. Other positions, byes, and opponents without data are left out. */
export function matchupInputs(ctx: MatchupContext | null, players: readonly RosterPlayer[]): Map<string, MatchupInput> {
  const out = new Map<string, MatchupInput>();
  if (!ctx) return out;
  const games = ctx.schedule.weeks.get(ctx.week);
  for (const p of players) {
    if (!MATCHUP_POSITIONS.has(p.position)) continue;
    const game = p.proTeam ? games?.get(p.proTeam) : undefined;
    const split = game ? ctx.splits.get(p.position)?.get(game.opponent) : undefined;
    if (!game || !split) continue;
    out.set(p.platformPlayerId, { opponent: game.opponent, home: game.home, ...split });
  }
  return out;
}
