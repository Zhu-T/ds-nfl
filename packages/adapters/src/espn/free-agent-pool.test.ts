import { describe, it, expect, afterEach, vi } from 'vitest';
import { EspnReader } from './adapter.js';

const ref = { platform: 'espn' as const, leagueId: '1', season: 2026, teamId: '1' };

const entry = (id: number) => ({
  status: 'FREEAGENT',
  player: { id, fullName: `Player ${id}`, defaultPositionId: 3, eligibleSlots: [], stats: [], injuryStatus: 'ACTIVE', proTeamId: 1 },
});

afterEach(() => vi.unstubAllGlobals());

describe('getFreeAgentPool', () => {
  it('asks for the best projected for the week and the most rostered, and merges them', async () => {
    const filters: any[] = [];
    vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      const filter = JSON.parse((init?.headers as Record<string, string>)['x-fantasy-filter'] ?? '{}');
      filters.push(filter.players);
      const ids = filter.players.sortAppliedStatTotal ? [11, 12, 13] : [13, 14];
      return new Response(JSON.stringify({ players: ids.map(entry) }));
    });

    const pool = await new EspnReader({ espnS2: 's', swid: '{w}' }).getFreeAgentPool(ref, 3, { byProjection: 3, byOwnership: 2 });

    const projected = filters.find((f) => f.sortAppliedStatTotal);
    const owned = filters.find((f) => f.sortPercOwned);
    // Source 1 (projection), split 1 (one week), season 2026, week 3.
    expect(projected).toMatchObject({ limit: 3, sortAppliedStatTotal: { sortAsc: false, value: '1120263' } });
    expect(owned).toMatchObject({ limit: 2, sortPercOwned: { sortAsc: false } });
    expect(pool.map((p) => p.platformPlayerId)).toEqual(['11', '12', '13', '14']);
  });
});
