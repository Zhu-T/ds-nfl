import { describe, it, expect, vi } from 'vitest';
import { EspnWriter, espnMessage, type DesiredSlot } from './writer.js';
import type { LeagueRef } from '../types.js';
import type { LineupSlot } from '@ds-nfl/core';

const ref: LeagueRef = { platform: 'espn', leagueId: '1', season: 2026, teamId: '4' };
const creds = { espnS2: 's2', swid: '{swid}' };

function change(over: Partial<DesiredSlot> = {}): DesiredSlot {
  return {
    platformPlayerId: '1',
    name: 'Player',
    fromSlot: 'BENCH' as LineupSlot,
    toSlot: 'WR' as LineupSlot,
    locked: false,
    ...over,
  };
}

/** Readback stub; these tests never reach the network. */
const noReadback = async () => new Map<string, LineupSlot>();

describe('EspnWriter guards', () => {
  const writer = new EspnWriter(creds, noReadback);

  it('refuses a locked player before sending anything', async () => {
    // ESPN answers a locked move with a 409 the user would have to decode.
    // Naming the player up front is both faster and clearer.
    await expect(
      writer.setLineup(ref, 1, [change({ name: 'Michael Wilson', locked: true })]),
    ).rejects.toThrow(/Michael Wilson.*locked/s);
  });

  it('names every locked player, not just the first', async () => {
    await expect(
      writer.setLineup(ref, 1, [
        change({ platformPlayerId: '1', name: 'Alpha', locked: true }),
        change({ platformPlayerId: '2', name: 'Beta', locked: true }),
      ]),
    ).rejects.toThrow(/Alpha, Beta are locked/);
  });

  it('refuses an empty change set rather than posting a no-op', async () => {
    await expect(writer.setLineup(ref, 1, [])).rejects.toThrow(/nothing to change/i);
  });
});

describe('espnMessage', () => {
  it('extracts ESPN’s own explanation from the error envelope', () => {
    const body = JSON.stringify({
      messages: ['Lineup transaction could not be completed, Michael Wilson is locked'],
      details: [{ type: 'TRAN_LINEUP_LOCKED' }],
    });
    expect(espnMessage(body)).toMatch(/Michael Wilson is locked/);
  });

  it('returns null for a body it cannot parse, so the raw text is used instead', () => {
    expect(espnMessage('<html>502</html>')).toBeNull();
    expect(espnMessage('{}')).toBeNull();
  });
});

describe('EspnWriter addDrop', () => {
  const add = { platformPlayerId: '99', name: 'Tre Tucker', toSlot: 'BENCH' as LineupSlot };
  const drop = { platformPlayerId: '7', name: 'Carson Wentz', fromSlot: 'BENCH' as LineupSlot };

  it('builds a free-agent add and drop without sending it, on a dry run', async () => {
    const res = await new EspnWriter(creds, noReadback).addDrop(ref, 3, { add, drop, kind: 'free-agent', dryRun: true });
    expect(res.state).toBe('not-sent');
    expect(res.request!.url).toContain('/seasons/2026/segments/0/leagues/1/transactions/');
    expect(res.request!.body).toMatchObject({
      teamId: 4,
      type: 'FREEAGENT',
      scoringPeriodId: 3,
      executionType: 'EXECUTE',
      items: [
        { playerId: 99, type: 'ADD', toLineupSlotId: 20 },
        { playerId: 7, type: 'DROP', fromLineupSlotId: 20 },
      ],
    });
    expect(res.request!.body).not.toHaveProperty('bidAmount');
  });

  it('sends a waiver claim with its bid, and reports it as submitted rather than done', async () => {
    const calls: { url: string; body: any }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response('{}', { status: 200 });
    });
    try {
      const res = await new EspnWriter(creds, noReadback).addDrop(ref, 3, { add, drop, kind: 'waivers', bid: 12 });
      expect(res.state).toBe('submitted');
      expect(res.message).toContain('$12');
      expect(calls[0]!.body).toMatchObject({ type: 'WAIVER', bidAmount: 12 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses a request that neither adds nor drops anyone', async () => {
    await expect(new EspnWriter(creds, noReadback).addDrop(ref, 3, { kind: 'free-agent' })).rejects.toThrow(/nothing to add or drop/i);
  });

  it('only calls a free-agent add done once the roster reads back with the player on it', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 200 }));
    try {
      const empty = new EspnWriter(creds, async () => new Map<string, LineupSlot>());
      await expect(empty.addDrop(ref, 3, { add, kind: 'free-agent' })).rejects.toThrow(/on the roster afterwards/);
      const onRoster = new EspnWriter(creds, async () => new Map<string, LineupSlot>([['99', 'BENCH' as LineupSlot]]));
      expect((await onRoster.addDrop(ref, 3, { add, kind: 'free-agent' })).state).toBe('done');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
