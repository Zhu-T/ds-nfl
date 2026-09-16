import { describe, it, expect } from 'vitest';
import { rankWaiverCandidates } from './evaluate.js';
import type { OptimizerPlayer } from '../lineup/optimize.js';
import type { RosterSettings } from '../types.js';

function p(name: string, position: OptimizerPlayer['position'], pts: number): OptimizerPlayer {
  return { gsisId: name, name, position, projectedPoints: pts, available: true };
}

const rs: RosterSettings = { slots: { QB: 1, WR: 1 }, benchSize: 3, irSize: 0 };

describe('rankWaiverCandidates', () => {
  const roster = [p('My QB', 'QB', 20), p('My WR', 'WR', 12), p('Bench WR', 'WR', 4)];

  it('prices a candidate by what they add to the starting lineup, not by projection', () => {
    // The RB projects highest of the three but cannot start in this roster, so
    // he is worth nothing. Raw projection would have ranked him first.
    const ranked = rankWaiverCandidates(
      roster,
      [p('Big RB', 'RB', 25), p('Better WR', 'WR', 17), p('Worse WR', 'WR', 9)],
      rs,
    );

    expect(ranked[0]?.player.name).toBe('Better WR');
    expect(ranked[0]?.lineupGain).toBe(5); // 17 replaces the 12
    expect(ranked.find((r) => r.player.name === 'Big RB')?.lineupGain).toBe(0);
    expect(ranked.find((r) => r.player.name === 'Worse WR')?.lineupGain).toBe(0);
  });

  it('names who the addition would displace', () => {
    const ranked = rankWaiverCandidates(roster, [p('Better WR', 'WR', 17)], rs);
    expect(ranked[0]?.displaces).toBe('My WR');
  });

  it('suggests the cheapest player to drop', () => {
    const ranked = rankWaiverCandidates(roster, [p('Better WR', 'WR', 17)], rs);
    expect(ranked[0]?.dropCandidate).toBe('Bench WR');
  });

  it('keeps zero-gain candidates rather than returning an empty list', () => {
    // "Nobody available helps" is a real answer and should be shown as one.
    const ranked = rankWaiverCandidates(roster, [p('Scrub', 'WR', 1)], rs);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.lineupGain).toBe(0);
  });

  it('never reports a negative gain, since you would simply not start them', () => {
    const ranked = rankWaiverCandidates(roster, [p('Bad', 'WR', 0)], rs);
    expect(ranked.every((r) => r.lineupGain >= 0)).toBe(true);
  });

  it('ignores a locked candidate’s ability to take a locked slot', () => {
    const lockedRoster = [
      { ...p('My QB', 'QB', 20), lockedToSlot: 'QB' as const },
      { ...p('My WR', 'WR', 12), lockedToSlot: 'WR' as const },
    ];
    // Both slots are frozen, so nobody can help this week.
    const ranked = rankWaiverCandidates(lockedRoster, [p('Star WR', 'WR', 30)], rs);
    expect(ranked[0]?.lineupGain).toBe(0);
  });
});
