import { describe, it, expect } from 'vitest';
import { SleeperReader } from './adapter.js';
import type { LeagueRef } from '../types.js';

/**
 * Fixtures shaped like real Sleeper responses. `fetch` is injected through the
 * constructor rather than patched globally, so these run with no network and no
 * mocking of built-ins.
 */
const FIXTURES: Record<string, unknown> = {
  '/state/nfl': { week: 2, season: '2026' },
  '/league/999': {
    name: 'Dynasty Test',
    season: '2026',
    total_rosters: 10,
    scoring_settings: { rec: 1 },
    roster_positions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN', 'IR'],
  },
  '/league/999/rosters': [
    { roster_id: 1, owner_id: 'u1', starters: ['p1', 'p2'], players: ['p1', 'p2', 'p3'], settings: { wins: 1, losses: 0 } },
    { roster_id: 2, owner_id: 'u2', starters: [], players: [], settings: { wins: 0, losses: 1 } },
  ],
  '/league/999/users': [
    { user_id: 'u1', display_name: 'tony', metadata: { team_name: 'Tony FC' } },
    { user_id: 'u2', display_name: 'other' },
  ],
  '/league/999/matchups/2': [
    { roster_id: 1, matchup_id: 7, points: 88.4 },
    { roster_id: 2, matchup_id: 7, points: 91.2 },
  ],
  '/players/nfl': {
    p1: { full_name: 'Test QB', position: 'QB', fantasy_positions: ['QB'], team: 'KC' },
    p2: { full_name: 'Test RB', position: 'RB', fantasy_positions: ['RB'], team: 'SF' },
    p3: { full_name: 'Hurt WR', position: 'WR', fantasy_positions: ['WR'], team: 'BUF', injury_status: 'Out' },
  },
};

const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input).replace('https://api.sleeper.app/v1', '');
  const body = FIXTURES[url];
  if (body === undefined) {
    return new Response('not found', { status: 404 });
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}) as typeof fetch;

const ref: LeagueRef = { platform: 'sleeper', leagueId: '999', season: 2026, teamId: '1' };
const reader = new SleeperReader(fakeFetch);

describe('SleeperReader capabilities', () => {
  it('declares no write path at all', () => {
    for (const cap of [
      reader.capabilities.setLineup,
      reader.capabilities.addDrop,
      reader.capabilities.proposeTrade,
    ]) {
      expect(cap.supported).toBe(false);
      if (!cap.supported) expect(cap.reason).toMatch(/no public write API/);
    }
  });

  it('declares that it has no projections, which lineup advice depends on', () => {
    const cap = reader.capabilities.projections;
    expect(cap.supported).toBe(false);
    if (!cap.supported) expect(cap.reason).toBeTruthy();
  });

  it('declares its reads as stable, unlike ESPN reverse-engineering', () => {
    const cap = reader.capabilities.league;
    expect(cap.supported).toBe(true);
    if (cap.supported) {
      expect(cap.confidence).toBe('stable');
      expect(cap.mechanism).toBe('public-api');
    }
  });
});

describe('SleeperReader reads', () => {
  it('turns roster_positions into typed roster settings', async () => {
    const league = await reader.getLeague(ref);
    expect(league.name).toBe('Dynasty Test');
    expect(league.teamCount).toBe(10);
    expect(league.currentWeek).toBe(2);
    expect(league.formatLabel).toBe('10-team · Full PPR');
    expect(league.rosterSettings.slots).toEqual({ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 });
    expect(league.rosterSettings.benchSize).toBe(2);
    expect(league.rosterSettings.irSize).toBe(1);
  });

  it('prefers a custom team name over the display name', async () => {
    const teams = await reader.getTeams(ref);
    expect(teams.find((t) => t.teamId === '1')?.name).toBe('Tony FC');
    expect(teams.find((t) => t.teamId === '2')?.name).toBe('other');
    expect(teams.filter((t) => t.isMine)).toHaveLength(1);
  });

  it('reads a roster and reports zero projections rather than inventing them', async () => {
    const roster = await reader.getRoster(ref, 2);
    expect(roster.players).toHaveLength(3);
    for (const p of roster.players) expect(p.projectedPoints).toBe(0);

    const hurt = roster.players.find((p) => p.name === 'Hurt WR');
    expect(hurt?.available).toBe(false);
    expect(hurt?.unavailableReason).toBe('Out');
  });

  it('places starters into the league slot order and benches the rest', async () => {
    const roster = await reader.getRoster(ref, 2);
    expect(roster.players.find((p) => p.name === 'Test QB')?.currentSlot).toBe('QB');
    expect(roster.players.find((p) => p.name === 'Test RB')?.currentSlot).toBe('RB');
    expect(roster.players.find((p) => p.name === 'Hurt WR')?.currentSlot).toBe('BENCH');
  });

  it('pairs a matchup by matchup_id', async () => {
    const m = await reader.getMatchup(ref, 2);
    expect(m?.myTeamName).toBe('Tony FC');
    expect(m?.opponentTeamName).toBe('other');
    expect(m?.opponentLive).toBe(91.2);
  });

  it('fails loudly on an unknown league instead of returning an empty shell', async () => {
    const missing: LeagueRef = { ...ref, leagueId: 'nope' };
    await expect(reader.getLeague(missing)).rejects.toThrow(/not found|Sleeper resource/i);
  });
});
