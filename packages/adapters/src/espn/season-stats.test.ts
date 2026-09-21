import { describe, it, expect, afterEach, vi } from 'vitest';
import { EspnReader } from './adapter.js';

const ref = { platform: 'espn' as const, leagueId: '1', season: 2026, teamId: '1' };

afterEach(() => vi.unstubAllGlobals());

describe("a player's season numbers", () => {
  it("reads this season's actual average and the rest-of-season projection, ignoring last season's rows", async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(
        JSON.stringify({
          players: [
            {
              status: 'FREEAGENT',
              player: {
                id: 1,
                fullName: 'Trevor Lawrence',
                defaultPositionId: 1,
                eligibleSlots: [],
                injuryStatus: 'ACTIVE',
                proTeamId: 30,
                stats: [
                  { seasonId: 2026, statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 2, appliedTotal: 17 },
                  { seasonId: 2025, statSourceId: 0, statSplitTypeId: 0, scoringPeriodId: 0, appliedTotal: 367.2, appliedAverage: 21.6 },
                  { seasonId: 2026, statSourceId: 0, statSplitTypeId: 0, scoringPeriodId: 0, appliedTotal: 30.1, appliedAverage: 30.1 },
                  { seasonId: 2026, statSourceId: 1, statSplitTypeId: 2, scoringPeriodId: 0, appliedTotal: 314.2, appliedAverage: 19.6375 },
                  { seasonId: 2026, statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 2, appliedTotal: 24.36 },
                  { seasonId: 2026, statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 1, appliedTotal: 30.1 },
                ],
              },
            },
            {
              status: 'FREEAGENT',
              player: { id: 2, fullName: 'Rookie', defaultPositionId: 2, eligibleSlots: [], injuryStatus: 'ACTIVE', proTeamId: 1, stats: [] },
            },
          ],
        }),
      ),
    );

    const [lawrence, rookie] = await new EspnReader({ espnS2: 's', swid: '{w}' }).getPlayersByIds(ref, 2, ['1', '2']);
    expect(lawrence).toMatchObject({
      projectedPoints: 17,
      seasonAverage: 30.1,
      gamesPlayed: 1,
      restOfSeasonAverage: 19.6,
      restOfSeasonGames: 16,
      // The week asked for, not an earlier one.
      actualPoints: 24.36,
    });
    expect(rookie!.actualPoints).toBeUndefined();
    expect(rookie!.seasonAverage).toBeUndefined();
    expect(rookie!.restOfSeasonAverage).toBeUndefined();
  });
});
