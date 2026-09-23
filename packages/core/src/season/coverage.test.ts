import { describe, it, expect } from 'vitest';
import { coverageByWeek, type CoveragePlayer } from './coverage.js';
import type { Position, RosterSettings } from '../types.js';

const settings: RosterSettings = { slots: { QB: 1, RB: 2, FLEX: 1 }, benchSize: 4, irSize: 1 };

const p = (id: string, position: Position, perGame: number, offWeeks: number[] = [], available = true): CoveragePlayer => ({
  gsisId: id,
  name: id,
  position,
  eligibleSlots: position === 'QB' ? ['QB'] : ['RB', 'FLEX'],
  perGame,
  available,
  ...(available ? {} : { unavailableReason: 'Out for the season' }),
  offWeeks: new Set(offWeeks),
});

describe('coverageByWeek', () => {
  it('finds the week two backs are off at once and the lineup cannot be filled', () => {
    const roster = [p('qb', 'QB', 18), p('rb1', 'RB', 14, [7]), p('rb2', 'RB', 11, [7]), p('rb3', 'RB', 6)];
    const weeks = coverageByWeek(roster, [6, 7], settings);
    expect(weeks[0]!.short).toEqual([]);
    expect(weeks[0]!.projected).toBe(49);
    // Week 7: only rb3 is left for two RB slots and the flex.
    expect(weeks[1]!.short).toEqual(['RB', 'FLEX']);
    expect(weeks[1]!.missing.map((m) => m.name)).toEqual(['rb1', 'rb2']);
  });

  it('counts a player who cannot play at all as missing every week, with the reason', () => {
    const weeks = coverageByWeek([p('qb', 'QB', 18, [], false), p('rb1', 'RB', 9), p('rb2', 'RB', 8), p('rb3', 'RB', 7)], [5], settings);
    expect(weeks[0]!.short).toEqual(['QB']);
    expect(weeks[0]!.missing).toEqual([{ name: 'qb', reason: 'Out for the season' }]);
  });
});
