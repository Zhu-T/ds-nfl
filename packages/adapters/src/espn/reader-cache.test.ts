import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EspnReader, clearLeagueCache } from './adapter.js';

const ref = { platform: 'espn' as const, leagueId: '1', season: 2026, teamId: '1' };

/** A league with two empty rosters, and a count of requests by view. */
function stubEspn() {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.searchParams.getAll('view').join('+'));
    const body = url.searchParams.getAll('view').includes('mSettings')
      ? {
          scoringPeriodId: 1,
          status: { finalScoringPeriod: 17 },
          settings: { name: 'L', size: 2, rosterSettings: { lineupSlotCounts: { '0': 1 } }, scoringSettings: { scoringItems: [] } },
        }
      : { teams: [{ id: 1, roster: { entries: [] } }, { id: 2, roster: { entries: [] } }] };
    return new Response(JSON.stringify(body));
  });
  return calls;
}

beforeEach(() => clearLeagueCache());
afterEach(() => vi.unstubAllGlobals());

describe('EspnReader request reuse', () => {
  it("reads a week's rosters once per reader, for any team", async () => {
    const calls = stubEspn();
    const reader = new EspnReader({ espnS2: 's', swid: '{w}' });
    await Promise.all([reader.getRoster(ref, 2), reader.getRoster({ ...ref, teamId: '2' }, 2)]);
    expect(calls.filter((c) => c === 'mRoster')).toHaveLength(1);
  });

  it('reads again for the readback that confirms a write', async () => {
    const calls = stubEspn();
    const reader = new EspnReader({ espnS2: 's', swid: '{w}' });
    await reader.getRoster(ref, 2);
    await reader.getSlotMap(ref, 2);
    expect(calls.filter((c) => c === 'mRoster')).toHaveLength(2);
  });

  it('shares league settings across readers for a minute', async () => {
    const calls = stubEspn();
    await new EspnReader({ espnS2: 's', swid: '{w}' }).getLeague(ref);
    await new EspnReader({ espnS2: 's', swid: '{w}' }).getLeague(ref);
    expect(calls.filter((c) => c.includes('mSettings'))).toHaveLength(1);
  });

  it('does not keep a failed read', async () => {
    let fail = true;
    const calls: string[] = [];
    vi.stubGlobal('fetch', async () => {
      calls.push('x');
      if (fail) return new Response('down', { status: 503 });
      return new Response(JSON.stringify({ teams: [{ id: 1, roster: { entries: [] } }] }));
    });
    const reader = new EspnReader({ espnS2: 's', swid: '{w}' });
    await expect(reader.getRoster(ref, 2)).rejects.toThrow();
    fail = false;
    await expect(reader.getRoster(ref, 2)).resolves.toMatchObject({ teamId: '1' });
    expect(calls).toHaveLength(2);
  });
});
