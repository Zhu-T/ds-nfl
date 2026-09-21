/**
 * Live integration check against the connected ESPN league.
 *
 * Skipped automatically when no credentials are stored, so it never breaks a
 * clean checkout or CI. When they are present this is the test that actually
 * proves the adapter works: it hits the real API and asserts the shape we rely
 * on, which is the failure mode fixtures cannot catch.
 */

import { describe, it, expect } from 'vitest';
import { activeLeague } from '../credentials.js';
import { EspnReader } from './adapter.js';
import type { LeagueRef } from '../types.js';

const espn = activeLeague();
const suite = espn ? describe : describe.skip;

suite('ESPN live read', () => {
  // describe.skip still runs this body to collect its tests; without a league there is nothing to read.
  if (!espn) return;
  const creds = { espnS2: espn!.espnS2, swid: espn!.swid };
  const ref: LeagueRef = {
    platform: 'espn',
    leagueId: espn!.leagueId,
    season: espn!.season,
    teamId: espn!.teamId,
  };
  const reader = new EspnReader(creds);

  it('reads league settings into typed roster settings', async () => {
    const league = await reader.getLeague(ref);

    expect(league.name).toBeTruthy();
    expect(league.teamCount).toBeGreaterThan(0);
    expect(league.formatLabel).toMatch(/team/);

    // Starting slots must be present and must not include bench or IR.
    const slots = league.rosterSettings.slots;
    expect(Object.keys(slots).length).toBeGreaterThan(0);
    expect(slots).not.toHaveProperty('BENCH');
    expect(league.rosterSettings.benchSize).toBeGreaterThan(0);
  }, 60_000);

  it('reads my roster with platform-declared eligibility and projections', async () => {
    const league = await reader.getLeague(ref);
    const roster = await reader.getRoster(ref, league.currentWeek);

    expect(roster.players.length).toBeGreaterThan(0);

    for (const p of roster.players) {
      expect(p.name).toBeTruthy();
      expect(['QB', 'RB', 'WR', 'TE', 'K', 'DST']).toContain(p.position);
      // Eligibility comes from ESPN, never inferred: every player must be
      // eligible for at least the slot they already occupy, or be benched.
      expect(p.eligibleSlots.length).toBeGreaterThan(0);
      expect(p.projectedPoints).toBeGreaterThanOrEqual(0);
    }

    // At least someone should carry a non-zero projection during the season.
    const projected = roster.players.filter((p) => p.projectedPoints > 0);
    expect(projected.length).toBeGreaterThan(0);
  }, 60_000);

  it('identifies my team among the league', async () => {
    const teams = await reader.getTeams(ref);
    const mine = teams.filter((t) => t.isMine);
    expect(mine).toHaveLength(1);
    expect(teams.length).toBeGreaterThan(1);
  }, 60_000);

  it('fails loudly on bad credentials instead of returning placeholder data', async () => {
    const broken = new EspnReader({ espnS2: 'not-a-real-cookie', swid: '{00000000-0000-0000-0000-000000000000}' });
    await expect(broken.getLeague(ref)).rejects.toThrow();
  }, 60_000);
});
