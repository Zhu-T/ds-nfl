import { describe, it, expect } from 'vitest';
import { SPREAD_MODEL, spreadBucket, spreadFor } from './spread.js';

describe('spreadFor', () => {
  it('scales the position spread and ceiling with the projection', () => {
    const b = spreadBucket('WR', 12);
    expect(spreadFor('WR', 12)).toEqual({ sd: Math.round(12 * b.relSd * 100) / 100, ceiling: Math.round(12 * (1 + b.relCeiling) * 100) / 100 });
  });

  it('gives low projections a wider relative spread than high ones', () => {
    expect(spreadBucket('RB', 4).relSd).toBeGreaterThan(spreadBucket('RB', 18).relSd);
  });

  it('never goes below zero, and covers every position', () => {
    expect(spreadFor('QB', -2)).toEqual({ sd: 0, ceiling: 0 });
    for (const pos of Object.keys(SPREAD_MODEL) as (keyof typeof SPREAD_MODEL)[]) expect(spreadFor(pos, 10).ceiling).toBeGreaterThan(10);
  });
});
