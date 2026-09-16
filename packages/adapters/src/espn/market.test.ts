import { describe, it, expect } from 'vitest';
import { marketAdjustment } from './market.js';
import { parseEspnScoring } from './scoring.js';

// Half-PPR: 0.04 per passing yard, 0.1 per rushing/receiving yard, 0.5 per reception,
// 4 per passing TD, 6 per receiving TD.
const halfPpr = parseEspnScoring([
  { statId: 3, points: 0.04 },
  { statId: 4, points: 4 },
  { statId: 24, points: 0.1 },
  { statId: 42, points: 0.1 },
  { statId: 43, points: 6 },
  { statId: 53, points: 0.5 },
] as any);
const standard = parseEspnScoring([{ statId: 42, points: 0.1 }, { statId: 43, points: 6 }] as any);

const wr = {
  projectedPoints: 11.8,
  positionId: 3,
  // 60.7 receiving yards, 4 receptions, 0.63 receiving TDs.
  projectedStats: { '42': 60.7, '53': 4, '43': 0.63 },
};

describe('marketAdjustment', () => {
  it('averages ESPN and the line for each stat with a line, and rescores', () => {
    const m = marketAdjustment(wr, { recYds: 70.5, receptions: 5.5 }, halfPpr);
    // Yards 60.7 → 65.6 (+0.49 pts), receptions 4 → 4.75 (+0.375 pts): +0.865.
    expect(m).toEqual({
      espn: 11.8,
      blended: 12.7,
      lines: [
        { stat: 'receiving yards', line: 70.5, espn: 60.7 },
        { stat: 'receptions', line: 5.5, espn: 4 },
      ],
    });
  });

  it('only counts what the league scores: receptions are worth nothing in standard', () => {
    const m = marketAdjustment(wr, { recYds: 70.5, receptions: 5.5 }, standard);
    expect(m?.blended).toBe(12.3);
  });

  it('can lower a projection, and leaves touchdowns alone', () => {
    const qb = { projectedPoints: 20.3, positionId: 1, projectedStats: { '3': 263.9, '4': 2.17 } };
    const m = marketAdjustment(qb, { passYds: 239.5 }, halfPpr);
    // 263.9 → 251.7: -0.488 pts.
    expect(m?.blended).toBe(19.8);
  });

  it('returns null when there is nothing to blend', () => {
    expect(marketAdjustment(wr, undefined, halfPpr)).toBeNull();
    expect(marketAdjustment(wr, {}, halfPpr)).toBeNull();
    expect(marketAdjustment({ projectedPoints: 5 }, { recYds: 50 }, halfPpr)).toBeNull();
    // A line for a stat the league does not score changes nothing.
    expect(marketAdjustment({ ...wr, projectedStats: { '53': 4 } }, { receptions: 6 }, standard)).toBeNull();
  });
});
