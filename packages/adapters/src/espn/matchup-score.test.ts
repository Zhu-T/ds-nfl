import { describe, it, expect, afterEach, vi } from 'vitest';
import { EspnReader } from './adapter.js';

const ref = { platform: 'espn' as const, leagueId: '1', season: 2026, teamId: '1' };

/** One pairing, with the fields ESPN fills at a given point in the week. */
function stub(home: Record<string, unknown>, away: Record<string, unknown>) {
  vi.stubGlobal('fetch', async () =>
    new Response(
      JSON.stringify({
        teams: [
          { id: 1, name: 'Mine' },
          { id: 2, name: 'Theirs' },
        ],
        schedule: [{ matchupPeriodId: 3, home: { teamId: 1, ...home }, away: { teamId: 2, ...away } }],
      }),
    ),
  );
  return new EspnReader({ espnS2: 's', swid: '{w}' });
}

afterEach(() => vi.unstubAllGlobals());

describe('getMatchup scores', () => {
  it('reads the running total while the games are on, which ESPN keeps apart from the final', async () => {
    // Mid-week: totalPoints sits at zero and the live fields carry everything.
    const reader = stub(
      { totalPoints: 0, totalPointsLive: 0, totalProjectedPoints: 108.7, totalProjectedPointsLive: 108.7 },
      { totalPoints: 0, totalPointsLive: 18.5, totalProjectedPoints: 116.1, totalProjectedPointsLive: 125.1 },
    );
    const m = await reader.getMatchup(ref, 3);
    expect(m).toMatchObject({ myLive: 0, opponentLive: 18.5, opponentProjected: 125.1 });
  });

  it('reads the final once the week is over, when the live fields are gone', async () => {
    const reader = stub({ totalPoints: 123.9, totalProjectedPoints: 110 }, { totalPoints: 107.5, totalProjectedPoints: 116.1 });
    const m = await reader.getMatchup(ref, 3);
    expect(m).toMatchObject({ myLive: 123.9, opponentLive: 107.5, opponentProjected: 116.1 });
  });
});
