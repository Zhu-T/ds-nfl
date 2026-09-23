/**
 * Playoff odds for the league: every team's remaining weeks played out many
 * times (see packages/core/src/season/simulate.ts).
 *
 * A team scores what its best lineup projects from here on — ESPN's
 * rest-of-season rate per player, which is steadier than a week's projection —
 * with the spread those players carry. Nobody's future lineup decisions are
 * guessed at: each team is assumed to start its best available players.
 */

import 'server-only';
import { optimizeLineup, simulateSeason, spreadFor, type SimTeam } from '@ds-nfl/core';
import type { EspnReader, LeagueInfo, LeagueRef, RosterPlayer } from '@ds-nfl/adapters';

export interface OddsRow {
  readonly teamId: string;
  readonly name: string;
  readonly isMine: boolean;
  readonly wins: number;
  readonly losses: number;
  /** Chance of reaching the playoffs, in percent. */
  readonly playoffs: number;
  readonly averageWins: number;
  readonly averageSeed: number;
  /** What their best remaining lineup projects per week. */
  readonly perWeek: number;
}

export interface WeekSwing {
  readonly week: number;
  readonly opponent: string;
  /** In percent. */
  readonly winProbability: number;
  readonly ifWin: number;
  readonly ifLose: number;
}

export interface SeasonOddsView {
  readonly rows: readonly OddsRow[];
  readonly playoffTeams: number;
  readonly regularSeasonWeeks: number;
  readonly runs: number;
  /** Your remaining weeks, most valuable first. */
  readonly swings: readonly WeekSwing[];
}

/** Enough runs for odds steady to about a point, without making the page wait. */
const RUNS = 10_000;

/** What a roster scores in a week from here on: its best lineup on rest-of-season rates. */
function weekly(players: readonly RosterPlayer[], settings: LeagueInfo['rosterSettings']): { mean: number; sd: number } {
  const lineup = optimizeLineup(
    players.map((p) => ({
      gsisId: p.platformPlayerId,
      name: p.name,
      position: p.position,
      eligibleSlots: p.eligibleSlots,
      projectedPoints: p.restOfSeasonAverage ?? p.projectedPoints,
      available: p.available && p.currentSlot !== 'IR',
    })),
    settings,
  );
  const starters = lineup.starters.flatMap((s) => (s.player ? [s.player] : []));
  return {
    mean: Math.round(lineup.projectedPoints * 10) / 10,
    sd: Math.sqrt(starters.reduce((s, p) => s + spreadFor(p.position, p.projectedPoints).sd ** 2, 0)),
  };
}

/** Null when the league does not say how many teams make the playoffs (Sleeper, or an odd setup). */
export async function seasonOdds(
  reader: EspnReader,
  ref: LeagueRef,
  league: LeagueInfo,
  week: number,
): Promise<SeasonOddsView | null> {
  if (!(league.playoffTeamCount > 0)) return null;
  const [teams, rosters, schedule] = await Promise.all([
    reader.getTeams(ref),
    reader.getAllRosters(ref, week),
    reader.getSchedule(ref),
  ]);

  const sims: SimTeam[] = teams.map((t) => {
    const { mean, sd } = weekly(rosters.get(t.teamId) ?? [], league.rosterSettings);
    return {
      teamId: t.teamId,
      wins: t.wins ?? 0,
      losses: t.losses ?? 0,
      ties: t.ties ?? 0,
      pointsFor: t.pointsFor ?? 0,
      mean,
      sd,
    };
  });
  const remaining = schedule.filter((m) => m.week >= week && m.week <= league.regularSeasonWeeks);
  const myTeamId = String(ref.teamId);
  const sim = simulateSeason({
    teams: sims,
    remaining,
    playoffTeams: league.playoffTeamCount,
    teamId: myTeamId,
    runs: RUNS,
    // Stable per league and week, so the odds do not jitter between page loads.
    seed: Number(`${week}${String(ref.leagueId).slice(-4)}`),
  });

  const names = new Map(teams.map((t) => [t.teamId, t.name]));
  const byId = new Map(sim.odds.map((o) => [o.teamId, o]));
  const pct = (x: number) => Math.round(x * 1000) / 10;
  return {
    playoffTeams: league.playoffTeamCount,
    regularSeasonWeeks: league.regularSeasonWeeks,
    runs: sim.runs,
    rows: teams
      .map((t) => {
        const o = byId.get(t.teamId);
        const s = sims.find((x) => x.teamId === t.teamId)!;
        return {
          teamId: t.teamId,
          name: t.name,
          isMine: t.teamId === myTeamId,
          wins: t.wins ?? 0,
          losses: t.losses ?? 0,
          playoffs: pct(o?.playoffs ?? 0),
          averageWins: Math.round((o?.averageWins ?? 0) * 10) / 10,
          averageSeed: Math.round((o?.averageSeed ?? 0) * 10) / 10,
          perWeek: s.mean,
        };
      })
      .sort((a, b) => b.playoffs - a.playoffs || b.averageWins - a.averageWins),
    swings: sim.importance
      .map((i) => ({
        week: i.week,
        opponent: names.get(i.opponentTeamId) ?? 'Opponent',
        winProbability: pct(i.winProbability),
        ifWin: pct(i.playoffsIfWin),
        ifLose: pct(i.playoffsIfLose),
      }))
      .sort((a, b) => b.ifWin - b.ifLose - (a.ifWin - a.ifLose)),
  };
}
