import { describe, it, expect, afterEach, vi } from 'vitest';
import { gamesBefore, parsePositionalRatings, parseProSchedule } from './matchups.js';
import { EspnReader, clearScheduleCache } from './adapter.js';

const ref = { platform: 'espn' as const, leagueId: '1', season: 2026, teamId: '1' };

describe('parsePositionalRatings', () => {
  it('reads points allowed per position and defense, with the rank, keyed by team', () => {
    const ratings = parsePositionalRatings({
      positionAgainstOpponent: {
        positionalRatings: {
          '1': { average: 18.59, ratingsByOpponent: { '34': { average: 36.84, rank: 30 }, '4': { average: 11.64, rank: 7 } } },
          '16': { average: 6.1, ratingsByOpponent: { '29': { average: 9, rank: 25 } } },
          '99': { average: 1, ratingsByOpponent: {} },
        },
      },
    });
    expect(ratings.get('QB')?.average).toBe(18.59);
    expect(ratings.get('QB')?.byOpponent.get('HOU')).toEqual({ allowed: 36.84, rank: 30 });
    expect(ratings.get('QB')?.byOpponent.get('CIN')).toEqual({ allowed: 11.64, rank: 7 });
    expect(ratings.get('DST')?.byOpponent.get('CAR')).toEqual({ allowed: 9, rank: 25 });
    expect(ratings.size).toBe(2);
  });

  it('reads nothing from an unexpected shape', () => {
    expect(parsePositionalRatings(null).size).toBe(0);
    expect(parsePositionalRatings({ positionAgainstOpponent: {} }).size).toBe(0);
  });
});

describe('parseProSchedule', () => {
  it('gives each team its opponent and side each week, and counts games before a week', () => {
    const schedule = parseProSchedule({
      settings: {
        proTeams: [
          { id: 4, proGamesByScoringPeriod: { '1': [{ homeProTeamId: 4, awayProTeamId: 5 }], '2': [{ homeProTeamId: 34, awayProTeamId: 4 }] } },
          { id: 34, proGamesByScoringPeriod: { '2': [{ homeProTeamId: 34, awayProTeamId: 4 }] } },
        ],
      },
    });
    expect(schedule.weeks.get(2)?.get('CIN')).toEqual({ opponent: 'HOU', home: false });
    expect(schedule.weeks.get(2)?.get('HOU')).toEqual({ opponent: 'CIN', home: true });
    expect(schedule.weeks.get(1)?.get('CLE')).toEqual({ opponent: 'CIN', home: false });
    expect(gamesBefore(schedule, 'CIN', 2)).toBe(1);
    expect(gamesBefore(schedule, 'HOU', 2)).toBe(0);
    expect(gamesBefore(schedule, 'CIN', 3)).toBe(2);
  });
});

describe('EspnReader matchup reads', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearScheduleCache();
  });

  it("reads the week's ratings from the league, and the season schedule once across readers", async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      urls.push(String(input));
      const body = String(input).includes('proTeamSchedules')
        ? { settings: { proTeams: [] } }
        : { positionAgainstOpponent: { positionalRatings: {} } };
      return new Response(JSON.stringify(body));
    });

    await new EspnReader({ espnS2: 's', swid: '{w}' }).getPositionalRatings(ref, 2);
    await new EspnReader({ espnS2: 's', swid: '{w}' }).getProSchedule(ref);
    await new EspnReader({ espnS2: 's', swid: '{w}' }).getProSchedule(ref);
    expect(urls.filter((u) => u.includes('leagues/1?view=mPositionalRatings&scoringPeriodId=2'))).toHaveLength(1);
    expect(urls.filter((u) => u.endsWith('seasons/2026?view=proTeamSchedules_wl'))).toHaveLength(1);
  });
});
