/**
 * The NFL schedule from ESPN: who plays whom each week
 * (`view=proTeamSchedules_wl`, per season). Opponent strength itself is
 * measured from players' weekly actual and projected points; see
 * packages/core/src/matchup/adjust.ts.
 */

import type { OpponentGame } from '@ds-nfl/core';
import { PRO_TEAM_BY_ID } from './ids.js';
import type { RosterPlayer } from '../types.js';

export interface ProGame {
  readonly opponent: string;
  readonly home: boolean;
}

export interface ProSchedule {
  /** Week, then team abbreviation, to that team's game; a team on bye is absent. */
  readonly weeks: ReadonlyMap<number, ReadonlyMap<string, ProGame>>;
}

const num = (x: unknown): number => (typeof x === 'number' ? x : Number(x));

export function parseProSchedule(data: unknown): ProSchedule {
  const weeks = new Map<number, Map<string, ProGame>>();
  const teams = (data as { settings?: { proTeams?: unknown[] } } | null)?.settings?.proTeams ?? [];
  for (const team of teams) {
    const byPeriod = (team as { proGamesByScoringPeriod?: Record<string, unknown[]> }).proGamesByScoringPeriod ?? {};
    for (const [period, games] of Object.entries(byPeriod)) {
      for (const g of games ?? []) {
        const game = g as { homeProTeamId?: number; awayProTeamId?: number };
        const home = PRO_TEAM_BY_ID[game.homeProTeamId ?? -1];
        const away = PRO_TEAM_BY_ID[game.awayProTeamId ?? -1];
        const week = Number(period);
        if (!home || !away || !Number.isInteger(week)) continue;
        const map = weeks.get(week) ?? new Map<string, ProGame>();
        weeks.set(week, map);
        map.set(home, { opponent: away, home: true });
        map.set(away, { opponent: home, home: false });
      }
    }
  }
  return { weeks };
}

/** Games a team played in the weeks before `week`. */
export function gamesBefore(schedule: ProSchedule, team: string, week: number): number {
  let games = 0;
  for (const [w, teams] of schedule.weeks) if (w < week && teams.has(team)) games++;
  return games;
}

/**
 * Players' finished games as the opponent model reads them: whom each faced,
 * and what they scored and were projected that week. Players on bye, or
 * without a score yet, are left out.
 */
export function opponentGames(schedule: ProSchedule, weeks: ReadonlyMap<number, readonly RosterPlayer[]>): OpponentGame[] {
  return [...weeks].flatMap(([week, players]) =>
    players.flatMap((p) => {
      const game = p.proTeam ? schedule.weeks.get(week)?.get(p.proTeam) : undefined;
      return game && p.actualPoints !== undefined
        ? [{ week, position: p.position, opponent: game.opponent, actual: p.actualPoints, projected: p.projectedPoints }]
        : [];
    }),
  );
}
