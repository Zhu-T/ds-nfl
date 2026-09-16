import { describe, it, expect } from 'vitest';
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
