import { describe, it, expect } from 'vitest';
import { discoverEspnLeagues } from './discover.js';
import { AdapterFailure } from '../types.js';
import { activeLeague } from '../credentials.js';

const creds = { espnS2: 'secret-s2', swid: '{SECRET-SWID}' };

function respond(status: number, body: unknown, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(String(input), String((init?.headers as Record<string, string>)?.['Cookie'] ?? ''));
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

const fantasy = (entry: Record<string, unknown>) => ({ type: { code: 'fantasy' }, metaData: { entry } });

describe('discoverEspnLeagues', () => {
  it('lists football leagues with the team id, newest season first', async () => {
    const leagues = await discoverEspnLeagues(
      creds,
      respond(200, {
        preferences: [
          fantasy({ abbrev: 'FFL', entryId: 4, seasonId: 2025, name: 'Fantasy Football 2025', groups: [{ groupId: 1662359399, groupName: "2025 Tommy's League" }] }),
          fantasy({ abbrev: 'FFL', entryId: 7, seasonId: 2026, entryLocation: 'Big', entryNickname: 'Dogs', groups: [{ groupId: 555, groupName: 'Work League' }] }),
          fantasy({ abbrev: 'FFL', entryId: 4, seasonId: 2026, groups: [{ groupId: 1662359399, groupName: "2026 Tommy's League" }] }),
          fantasy({ abbrev: 'FLB', entryId: 2, seasonId: 2026, groups: [{ groupId: 9, groupName: 'Baseball' }] }),
          { type: { code: 'challengeEntry' }, metaData: { entry: { gameId: 46, groups: [] } } },
          { type: { code: 'team' } },
        ],
      }),
    );
    expect(leagues).toEqual([
      { leagueId: '1662359399', teamId: '4', season: 2026, leagueName: "2026 Tommy's League", teamName: null },
      { leagueId: '555', teamId: '7', season: 2026, leagueName: 'Work League', teamName: 'Big Dogs' },
      { leagueId: '1662359399', teamId: '4', season: 2025, leagueName: "2025 Tommy's League", teamName: null },
    ]);
  });

  it('sends both cookies', async () => {
    const seen: string[] = [];
    await discoverEspnLeagues(creds, respond(200, { preferences: [] }, seen));
    expect(seen[1]).toBe('espn_s2=secret-s2; SWID={SECRET-SWID}');
  });

  it('reports rejected cookies as a sign-in problem, without the SWID in the message', async () => {
    const error = await discoverEspnLeagues(creds, respond(401, {})).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdapterFailure);
    expect((error as AdapterFailure).error.kind).toBe('auth-required');
    expect((error as Error).message).not.toContain('SECRET');
  });

  it('keeps the SWID out of other failures too', async () => {
    for (const status of [404, 500]) {
      const error = (await discoverEspnLeagues(creds, respond(status, {})).catch((e: unknown) => e)) as Error;
      expect(error.message).not.toContain('SECRET');
    }
    const shape = (await discoverEspnLeagues(creds, respond(200, { nope: 1 })).catch((e: unknown) => e)) as Error;
    expect((shape as AdapterFailure).error.kind).toBe('shape-changed');
    expect(shape.message).not.toContain('SECRET');
  });
});

const league = activeLeague();
const suite = league ? describe : describe.skip;
suite('ESPN account leagues (live)', () => {
  it('includes the connected league, with the same team id', async () => {
    const found = await discoverEspnLeagues({ espnS2: league!.espnS2, swid: league!.swid });
    const match = found.find((l) => l.leagueId === league!.leagueId && l.season === league!.season);
    expect(match?.teamId).toBe(league!.teamId);
  }, 30_000);
});
