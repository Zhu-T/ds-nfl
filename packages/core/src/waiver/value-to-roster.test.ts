import { describe, it, expect } from 'vitest';
import { rankWaiverCandidates, valueToRoster } from './evaluate.js';
import type { OptimizerPlayer } from '../lineup/optimize.js';
import type { RosterSettings } from '../types.js';

function p(name: string, position: OptimizerPlayer['position'], pts: number, extra: Partial<OptimizerPlayer> = {}): OptimizerPlayer {
  return { gsisId: name, name, position, projectedPoints: pts, available: true, ...extra };
}

const rs: RosterSettings = { slots: { QB: 1, WR: 1 }, benchSize: 3, irSize: 0 };
const roster = [p('My QB', 'QB', 20), p('My WR', 'WR', 12), p('Bench WR', 'WR', 4)];

describe('valueToRoster', () => {
  it('prices a player you could add exactly as the waiver ranking does', () => {
    const better = p('Better WR', 'WR', 17);
    const v = valueToRoster(roster, better, rs);
    expect(v).toEqual({
      onRoster: false,
      withPlayer: 37,
      withoutPlayer: 32,
      value: 5,
      slot: 'WR',
      displaces: 'My WR',
      dropCandidate: 'Bench WR',
      replacedBy: null,
    });
    expect(v.value).toBe(rankWaiverCandidates(roster, [better], rs)[0]!.lineupGain);
  });

  it('is worth nothing when the player would not start, or cannot', () => {
    expect(valueToRoster(roster, p('Big RB', 'RB', 25), rs)).toMatchObject({ value: 0, slot: null, displaces: null });
    expect(valueToRoster(roster, p('Hurt WR', 'WR', 30, { available: false, unavailableReason: 'Out' }), rs)).toMatchObject({
      value: 0,
      slot: null,
    });
  });

  it('prices one of your own players by what losing them costs, and names who would start instead', () => {
    expect(valueToRoster(roster, roster[1]!, rs)).toEqual({
      onRoster: true,
      withPlayer: 32,
      withoutPlayer: 24,
      value: 8,
      slot: 'WR',
      displaces: null,
      dropCandidate: null,
      replacedBy: 'Bench WR',
    });
    expect(valueToRoster(roster, roster[2]!, rs)).toMatchObject({ onRoster: true, value: 0, slot: null, replacedBy: null });
  });
});
