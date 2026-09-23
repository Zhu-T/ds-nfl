import { describe, it, expect } from 'vitest';
import { livePendingMoves } from './transactions.js';
import type { LeagueTransaction } from './types.js';

const move = (id: string, status: LeagueTransaction['status'], at: string, adds: string[], drops: string[]): LeagueTransaction => ({
  id,
  teamId: '4',
  isMine: true,
  kind: 'waivers',
  status,
  week: 3,
  at,
  adds,
  drops,
});

const roster = new Set(['eagles', 'wentz']);

describe('livePendingMoves', () => {
  it('drops a claim that a later row cancelled, which ESPN leaves listed as pending', () => {
    const log = [
      move('claim', 'pending', '2026-09-23T17:23:18Z', ['loop'], ['eagles']),
      move('cancel', 'canceled', '2026-09-23T17:24:27Z', ['loop'], ['eagles']),
    ];
    expect(livePendingMoves(log, { onRoster: roster })).toEqual([]);
  });

  it('keeps a claim put in again after an earlier one was cancelled', () => {
    const log = [
      move('first', 'pending', '2026-09-23T10:00:00Z', ['loop'], ['eagles']),
      move('cancel', 'canceled', '2026-09-23T10:05:00Z', ['loop'], ['eagles']),
      move('again', 'pending', '2026-09-23T11:00:00Z', ['loop'], ['eagles']),
    ];
    expect(livePendingMoves(log, { onRoster: roster }).map((t) => t.id)).toEqual(['again']);
  });

  it('drops claims the roster has moved past, and keeps live ones newest first', () => {
    const log = [
      // The player it would drop has already gone.
      move('gone', 'pending', '2026-09-22T10:00:00Z', ['loop'], ['someone-else']),
      // The player it adds is already on the roster.
      move('had', 'pending', '2026-09-22T11:00:00Z', ['wentz'], ['eagles']),
      move('older', 'pending', '2026-09-23T09:00:00Z', ['tucker'], ['wentz']),
      move('newer', 'pending', '2026-09-23T12:00:00Z', ['loop'], ['eagles']),
    ];
    expect(livePendingMoves(log, { onRoster: roster }).map((t) => t.id)).toEqual(['newer', 'older']);
  });
});
