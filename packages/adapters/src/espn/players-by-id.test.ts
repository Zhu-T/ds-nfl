import { describe, it, expect, afterEach, vi } from 'vitest';
import { EspnReader } from './adapter.js';

const ref = { platform: 'espn' as const, leagueId: '1', season: 2026, teamId: '1' };
const player = (id: number) => ({ id, fullName: `Player ${id}`, defaultPositionId: 2, eligibleSlots: [], stats: [], injuryStatus: 'ACTIVE', proTeamId: 1 });

afterEach(() => vi.unstubAllGlobals());

describe('getPlayersByIds', () => {
  it('looks players up by id and says where each one is in the league', async () => {
    const filters: any[] = [];
    vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      filters.push(JSON.parse((init?.headers as Record<string, string>)['x-fantasy-filter'] ?? '{}'));
      return new Response(
        JSON.stringify({
          players: [
            { status: 'FREEAGENT', player: player(1) },
            { status: 'WAIVERS', player: player(2) },
            { status: 'ONTEAM', onTeamId: 7, player: player(3) },
          ],
        }),
      );
    });

    const found = await new EspnReader({ espnS2: 's', swid: '{w}' }).getPlayersByIds(ref, 3, ['1', '2', '3']);
    expect(filters[0]).toEqual({ players: { filterIds: { value: [1, 2, 3] } } });
    expect(found.map((p) => [p.platformPlayerId, p.pickup ?? null, p.onTeamId ?? null])).toEqual([
      ['1', 'free-agent', null],
      ['2', 'waivers', null],
      ['3', null, '7'],
    ]);
  });

  it('makes no request for an empty list', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    expect(await new EspnReader({ espnS2: 's', swid: '{w}' }).getPlayersByIds(ref, 3, [])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
