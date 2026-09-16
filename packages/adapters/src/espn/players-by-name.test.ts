import { describe, it, expect, afterEach, vi } from 'vitest';
import { EspnReader } from './adapter.js';

const ref = { platform: 'espn' as const, leagueId: '1', season: 2026, teamId: '1' };
const player = (id: number) => ({ id, fullName: `Player ${id}`, defaultPositionId: 2, eligibleSlots: [], stats: [], injuryStatus: 'ACTIVE', proTeamId: 1 });

afterEach(() => vi.unstubAllGlobals());

describe('searchPlayersByName', () => {
  it('searches the whole league by name, most rostered first, and says where each player is', async () => {
    const calls: { url: string; filter: unknown }[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        filter: JSON.parse((init?.headers as Record<string, string>)['x-fantasy-filter'] ?? '{}'),
      });
      return new Response(
        JSON.stringify({
          players: [
            { status: 'ONTEAM', onTeamId: 7, player: player(3) },
            { status: 'WAIVERS', player: player(2) },
          ],
        }),
      );
    });

    const found = await new EspnReader({ espnS2: 's', swid: '{w}' }).searchPlayersByName(ref, 2, '  Chase ');
    // ESPN rejects a name filter with no sort, so the ownership sort is required.
    expect(calls[0]!.filter).toEqual({
      players: { filterName: { value: 'Chase' }, limit: 10, sortPercOwned: { sortAsc: false, sortPriority: 1 } },
    });
    expect(calls[0]!.url).toContain('view=kona_player_info');
    expect(calls[0]!.url).toContain('scoringPeriodId=2');
    expect(found.map((p) => [p.platformPlayerId, p.onTeamId ?? null, p.pickup ?? null])).toEqual([
      ['3', '7', null],
      ['2', null, 'waivers'],
    ]);
  });

  it('makes no request for fewer than two letters', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    expect(await new EspnReader({ espnS2: 's', swid: '{w}' }).searchPlayersByName(ref, 2, ' c ')).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
