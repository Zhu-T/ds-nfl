/**
 * NFL matchups from ESPN: the fantasy points each defense allows to each
 * position (`view=mPositionalRatings`, per league), and the pro schedule, who
 * plays whom each week (`view=proTeamSchedules_wl`, per season).
 */

import type { Position } from '@ds-nfl/core';
import { PRO_TEAM_BY_ID, positionFromId } from './ids.js';

export interface DefenseRating {
  /** Fantasy points per game allowed to the position. */
  readonly allowed: number;
  /** 1 allows the fewest, 32 the most. */
  readonly rank: number;
}

export interface PositionRatings {
  /** The average across the league. */
  readonly average: number;
  /** By the defense's team abbreviation. */
  readonly byOpponent: ReadonlyMap<string, DefenseRating>;
}

export interface ProGame {
  readonly opponent: string;
  readonly home: boolean;
}

export interface ProSchedule {
  /** Week, then team abbreviation, to that team's game; a team on bye is absent. */
  readonly weeks: ReadonlyMap<number, ReadonlyMap<string, ProGame>>;
}

const num = (x: unknown): number => (typeof x === 'number' ? x : Number(x));

export function parsePositionalRatings(data: unknown): Map<Position, PositionRatings> {
  const out = new Map<Position, PositionRatings>();
  const ratings = (data as { positionAgainstOpponent?: { positionalRatings?: Record<string, unknown> } } | null)
    ?.positionAgainstOpponent?.positionalRatings;
  for (const [positionId, raw] of Object.entries(ratings ?? {})) {
    const entry = raw as { average?: unknown; ratingsByOpponent?: Record<string, { average?: unknown; rank?: unknown }> };
    const position = positionFromId(Number(positionId));
    const average = num(entry?.average);
    if (!position || !Number.isFinite(average)) continue;
    const byOpponent = new Map<string, DefenseRating>();
    for (const [teamId, r] of Object.entries(entry.ratingsByOpponent ?? {})) {
      const team = PRO_TEAM_BY_ID[Number(teamId)];
      const allowed = num(r?.average);
      const rank = num(r?.rank);
      if (team && team !== 'FA' && Number.isFinite(allowed) && Number.isFinite(rank)) byOpponent.set(team, { allowed, rank });
    }
    out.set(position, { average, byOpponent });
  }
  return out;
}

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
