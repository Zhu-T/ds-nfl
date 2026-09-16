import { describe, it, expect } from 'vitest';
import {
  PLAYER_POSITION_BY_ID,
  LINEUP_SLOT_BY_ID,
  positionFromId,
  slotFromId,
  availabilityFromInjury,
  rosterSettingsFromSlotCounts,
} from './ids.js';

describe('ESPN id spaces', () => {
  it('keeps the two position numberings separate where they collide', () => {
    // RB and D/ST share a number across the two id spaces. Mixing them produces
    // wrong-but-plausible lineups, so pin the collision explicitly.
    expect(PLAYER_POSITION_BY_ID[2]).toBe('RB');
    expect(LINEUP_SLOT_BY_ID[2]).toBe('RB');

    expect(PLAYER_POSITION_BY_ID[16]).toBe('DST');
    expect(LINEUP_SLOT_BY_ID[16]).toBe('DST');

    // ...and where they genuinely disagree:
    expect(PLAYER_POSITION_BY_ID[4]).toBe('TE'); // player id 4 is a tight end
    expect(LINEUP_SLOT_BY_ID[4]).toBe('WR'); // slot id 4 is a receiver slot
    expect(PLAYER_POSITION_BY_ID[1]).toBe('QB');
    expect(LINEUP_SLOT_BY_ID[1]).toBeUndefined();
  });

  it('maps both flex slot ids to FLEX', () => {
    expect(slotFromId(3)).toBe('FLEX');
    expect(slotFromId(23)).toBe('FLEX');
  });

  it('returns null for unknown ids rather than guessing', () => {
    expect(positionFromId(99)).toBeNull();
    expect(slotFromId(99)).toBeNull();
    expect(positionFromId(undefined)).toBeNull();
  });
});

describe('availabilityFromInjury', () => {
  it('benches players who cannot play', () => {
    for (const status of ['OUT', 'INJURY_RESERVE', 'SUSPENSION']) {
      expect(availabilityFromInjury(status).available).toBe(false);
    }
  });

  it('keeps questionable and doubtful players startable but flagged', () => {
    // Auto-benching these would silently cost points; the call stays with the user.
    for (const status of ['QUESTIONABLE', 'DOUBTFUL']) {
      const a = availabilityFromInjury(status);
      expect(a.available).toBe(true);
      expect(a.reason).toBeTruthy();
    }
  });

  it('treats active and missing status as available with no flag', () => {
    expect(availabilityFromInjury('ACTIVE')).toEqual({ available: true });
    expect(availabilityFromInjury(undefined)).toEqual({ available: true });
  });
});

describe('rosterSettingsFromSlotCounts', () => {
  // The real payload from 2026 Tommy's League.
  const REAL = {
    '0': 1, '1': 0, '2': 2, '3': 0, '4': 2, '5': 0, '6': 1, '7': 0, '8': 0, '9': 0,
    '10': 0, '11': 0, '12': 0, '13': 0, '14': 0, '15': 0, '16': 1, '17': 1, '18': 0,
    '19': 0, '20': 6, '21': 1, '22': 0, '23': 1, '24': 0,
  };

  it('reads a real league into typed roster settings', () => {
    const rs = rosterSettingsFromSlotCounts(REAL);
    expect(rs.slots).toEqual({ QB: 1, RB: 2, WR: 2, TE: 1, DST: 1, K: 1, FLEX: 1 });
    expect(rs.benchSize).toBe(6);
    expect(rs.irSize).toBe(1);
  });

  it('does not leak bench or IR into the starting slots', () => {
    const rs = rosterSettingsFromSlotCounts(REAL);
    expect(rs.slots).not.toHaveProperty('BENCH');
    expect(rs.slots).not.toHaveProperty('IR');
  });

  it('sums both flex slot ids into one FLEX count', () => {
    const rs = rosterSettingsFromSlotCounts({ '3': 1, '23': 1 });
    expect(rs.slots.FLEX).toBe(2);
  });

  it('ignores slot ids it does not recognise instead of inventing a slot', () => {
    const rs = rosterSettingsFromSlotCounts({ '0': 1, '99': 3 });
    expect(rs.slots).toEqual({ QB: 1 });
  });
});
