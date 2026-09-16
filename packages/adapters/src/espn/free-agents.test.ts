/**
 * Live checks on the free-agent pool. Skipped when no league is connected.
 *
 * Both guard real failure modes: recommending a pickup who belongs to another
 * team is advice nobody can follow, and calling a waiver player "available"
 * promises an instant add that ESPN will refuse.
 */

import { describe, it, expect } from 'vitest';
import { activeLeague } from '../credentials.js';
import { EspnReader } from './adapter.js';

const espn = activeLeague();
const suite = espn ? describe : describe.skip;

suite('ESPN free-agent pool (live)', () => {
  const reader = new EspnReader({ espnS2: espn!.espnS2, swid: espn!.swid });
  const ref = {
    platform: 'espn' as const,
    leagueId: espn!.leagueId,
    season: espn!.season,
    teamId: espn!.teamId,
  };

  it('never includes a player who is on any roster in the league', async () => {
    const week = (await reader.getLeague(ref)).currentWeek;
    const [free, all] = await Promise.all([
      reader.getFreeAgents(ref, week, 200),
      reader.getAllRosters(ref, week),
    ]);
    const rostered = new Set([...all.values()].flat().map((p) => p.platformPlayerId));

    expect(free.length).toBeGreaterThan(0);
    expect(free.filter((p) => rostered.has(p.platformPlayerId)).map((p) => p.name)).toEqual([]);
  }, 90_000);

  it('marks every unrostered player as a waiver claim or an instant add', async () => {
    const week = (await reader.getLeague(ref)).currentWeek;
    const free = await reader.getFreeAgents(ref, week, 200);
    for (const p of free) expect(['waivers', 'free-agent']).toContain(p.pickup);
  }, 90_000);
});
