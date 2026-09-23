import { describe, it, expect, afterEach, vi } from 'vitest';
import { gamesBefore, opponentGames, parseProSchedule } from './matchups.js';
import type { RosterPlayer } from '../types.js';
import { EspnReader, clearScheduleCache } from './adapter.js';

const ref = { platform: 'espn' as const, leagueId: '1', season: 2026, teamId: '1' };

describe('opponentGames', () => {
  it('pairs each finished game with the opponent faced that week, skipping byes and unplayed games', () => {
    const schedule = { weeks: new Map([[1, new Map([['HOU', { opponent: 'LAR', home: false }]])]]) };
    const dst = (proTeam: string, actual?: number): RosterPlayer => ({
      platformPlayerId: proTeam,
      name: `${proTeam} D/ST`,
      position: 'DST',
      eligibleSlots: ['DST'],
      currentSlot: 'BENCH',
      projectedPoints: 5.3,
      available: true,
      proTeam,
      locked: false,
      ...(actual !== undefined ? { actualPoints: actual } : {}),
    });
    const games = opponentGames(schedule, new Map([[1, [dst('HOU', -4), dst('KC', 9), dst('HOU')]]]));
    expect(games).toEqual([{ week: 1, position: 'DST', opponent: 'LAR', actual: -4, projected: 5.3 }]);
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

  it('reads every D/ST for a week in one call, and the season schedule once across readers', async () => {
    const calls: { url: string; filter: any }[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, filter: JSON.parse((init?.headers as Record<string, string> | undefined)?.['x-fantasy-filter'] ?? 'null') });
      const body = url.includes('proTeamSchedules')
        ? { settings: { proTeams: [] } }
        : {
            players: [
              {
                status: 'FREEAGENT',
                player: {
                  id: -16034,
                  fullName: 'Texans D/ST',
                  defaultPositionId: 16,
                  proTeamId: 34,
                  eligibleSlots: [16],
                  stats: [
                    { seasonId: 2026, statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 1, appliedTotal: 5.3 },
                    { seasonId: 2026, statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 1, appliedTotal: -4 },
                  ],
                },
              },
            ],
          };
      return new Response(JSON.stringify(body));
    });

    const [dst] = await new EspnReader({ espnS2: 's', swid: '{w}' }).getDefenseWeek(ref, 1);
    expect(dst).toMatchObject({ name: 'Texans D/ST', position: 'DST', proTeam: 'HOU', projectedPoints: 5.3, actualPoints: -4 });
    const kona = calls.find((c) => c.url.includes('kona_player_info'))!;
    expect(kona.url).toContain('scoringPeriodId=1');
    expect(kona.filter.players).toMatchObject({ filterSlotIds: { value: [16] }, limit: 40 });

    await new EspnReader({ espnS2: 's', swid: '{w}' }).getProSchedule(ref);
    await new EspnReader({ espnS2: 's', swid: '{w}' }).getProSchedule(ref);
    expect(calls.filter((c) => c.url.endsWith('seasons/2026?view=proTeamSchedules_wl'))).toHaveLength(1);
  });
});
