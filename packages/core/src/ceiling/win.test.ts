import { describe, it, expect } from 'vitest';
import { bestWinLineup, normalCdf, outlookOf, rankForWinChance, winChance, type WeekOutlook } from './win.js';
import { spreadFor } from './spread.js';
import type { OptimizerPlayer } from '../lineup/optimize.js';
import type { RosterSettings } from '../types.js';

const settings: RosterSettings = { slots: { WR: 1 }, benchSize: 3, irSize: 0 };
const wr = (id: string, pts: number): OptimizerPlayer => ({ gsisId: id, name: id, position: 'WR', eligibleSlots: ['WR'], projectedPoints: pts, available: true });

describe('normalCdf and winChance', () => {
  it('matches known values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.2816)).toBeCloseTo(0.9, 3);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
  });

  it('is even for equal teams, near certain for a big lead, and exact once everything is final', () => {
    expect(winChance({ mean: 100, variance: 400 }, { mean: 100, variance: 400 })).toBeCloseTo(0.5, 6);
    expect(winChance({ mean: 150, variance: 100 }, { mean: 100, variance: 100 })).toBeGreaterThan(0.99);
    expect(winChance({ mean: 101, variance: 0 }, { mean: 100, variance: 0 })).toBe(1);
    expect(winChance({ mean: 100, variance: 0 }, { mean: 100, variance: 0 })).toBe(0.5);
  });
});

describe('outlookOf', () => {
  it('uses the actual score once final, the larger of score and projection while live, and the projection before', () => {
    const p = wr('a', 10);
    expect(outlookOf(p, 'final', 23.5)).toEqual({ mean: 23.5, sd: 0 });
    expect(outlookOf(p, 'live', 4)).toEqual({ mean: 10, sd: spreadFor('WR', 10).sd / 2 });
    expect(outlookOf(p, 'upcoming')).toEqual({ mean: 10, sd: spreadFor('WR', 10).sd });
  });
});

describe('bestWinLineup', () => {
  // A steady receiver projected 12, and a boom-or-bust one projected 11.
  const steady = wr('steady', 12);
  const boom = wr('boom', 11);
  const outlook = (p: OptimizerPlayer): WeekOutlook => ({ mean: p.projectedPoints, sd: p.gsisId === 'boom' ? 12 : 2 });

  it('starts the higher projection when ahead, and the wider spread when far behind', () => {
    const ahead = bestWinLineup([steady, boom], settings, outlook, { mean: 5, variance: 4 });
    expect(ahead.solution.starters[0]!.player!.gsisId).toBe('steady');
    const behind = bestWinLineup([steady, boom], settings, outlook, { mean: 30, variance: 4 });
    expect(behind.solution.starters[0]!.player!.gsisId).toBe('boom');
    expect(behind.weight).toBeGreaterThan(0);
  });

  it('never does worse than the best-projected lineup', () => {
    for (const oppMean of [0, 8, 12, 15, 25, 60]) {
      const best = bestWinLineup([steady, boom], settings, outlook, { mean: oppMean, variance: 9 });
      const projected = winChance({ mean: 12, variance: 4 }, { mean: oppMean, variance: 9 });
      expect(best.chance).toBeGreaterThanOrEqual(projected - 1e-9);
    }
  });
});

describe('rankForWinChance', () => {
  it('ranks pickups by how much they raise the win chance', () => {
    const outlook = (p: OptimizerPlayer): WeekOutlook => ({ mean: p.projectedPoints, sd: p.gsisId === 'boom' ? 12 : 2 });
    const { base, ranked } = rankForWinChance([wr('mine', 10)], [wr('steady', 12), wr('boom', 11)], settings, outlook, { mean: 30, variance: 4 });
    expect(base.chance).toBeLessThan(0.01);
    expect(ranked[0]!.player.gsisId).toBe('boom');
    expect(ranked[0]!.gain).toBeGreaterThan(ranked[1]!.gain);
    expect(ranked[0]!.displaces).toBe('mine');
  });
});
