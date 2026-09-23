import { describe, it, expect } from 'vitest';
import { simulateSeason, type SimTeam } from './simulate.js';
import type { SeasonMatchup } from '../types.js';

const team = (id: string, wins: number, mean: number, pointsFor = wins * 100): SimTeam => ({
  teamId: id,
  wins,
  losses: 0,
  ties: 0,
  pointsFor,
  mean,
  sd: 20,
});

/** Four teams, each playing the others once more. */
const round = (week: number, a: string, b: string, c: string, d: string): SeasonMatchup[] => [
  { week, homeTeamId: a, awayTeamId: b },
  { week, homeTeamId: c, awayTeamId: d },
];

describe('simulateSeason', () => {
  const teams = [team('1', 3, 110), team('2', 2, 105), team('3', 1, 100), team('4', 0, 95)];
  const remaining = [...round(5, '1', '2', '3', '4'), ...round(6, '1', '3', '2', '4')];

  it('gives the same odds for the same seed, and fills exactly the playoff spots', () => {
    const a = simulateSeason({ teams, remaining, playoffTeams: 2, runs: 2000, seed: 7 });
    const b = simulateSeason({ teams, remaining, playoffTeams: 2, runs: 2000, seed: 7 });
    expect(a.odds).toEqual(b.odds);
    expect(a.odds.reduce((s, o) => s + o.playoffs, 0)).toBeCloseTo(2, 6);
    expect(a.odds.every((o) => o.playoffs >= 0 && o.playoffs <= 1)).toBe(true);
  });

  it('favours the team that is ahead and scores more', () => {
    const { odds } = simulateSeason({ teams, remaining, playoffTeams: 2, runs: 4000, seed: 3 });
    const by = Object.fromEntries(odds.map((o) => [o.teamId, o.playoffs]));
    expect(by['1']).toBeGreaterThan(by['2']!);
    expect(by['2']).toBeGreaterThan(by['4']!);
    expect(odds.find((o) => o.teamId === '1')!.averageWins).toBeGreaterThan(3);
  });

  it('is certain when the race is already settled', () => {
    const settled = [team('1', 9, 130), team('2', 8, 120), team('3', 0, 60), team('4', 0, 60)];
    const { odds } = simulateSeason({ teams: settled, remaining: round(6, '1', '3', '2', '4'), playoffTeams: 2, runs: 500, seed: 1 });
    expect(odds.find((o) => o.teamId === '1')!.playoffs).toBe(1);
    expect(odds.find((o) => o.teamId === '3')!.playoffs).toBe(0);
  });

  it('weighs each of your own games by the playoff odds behind winning it', () => {
    const { importance } = simulateSeason({ teams, remaining, playoffTeams: 2, runs: 4000, seed: 11, teamId: '2' });
    expect(importance.map((i) => [i.week, i.opponentTeamId])).toEqual([
      [5, '1'],
      [6, '4'],
    ]);
    for (const week of importance) {
      expect(week.winProbability).toBeGreaterThan(0.2);
      expect(week.playoffsIfWin).toBeGreaterThan(week.playoffsIfLose);
    }
  });
});
