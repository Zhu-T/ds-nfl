import { describe, it, expect } from 'vitest';
import { calibrateMarket, kickoffWindow, marketAdjustment } from './market.js';
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

describe('calibrateMarket', () => {
  const sample = (line: number, espn: number, window: 'near' | 'far' = 'near') => ({ key: 'recYds' as const, line, espn, window });

  it('makes no correction without lines', () => {
    const c = calibrateMarket([]);
    expect(c.factor('recYds', 'near')).toBe(1);
    expect(c.samples).toBe(0);
  });

  it('measures the typical ratio per kickoff window, pulled toward the week and the week toward 1', () => {
    // Twelve near-game lines all 20% above ESPN; none yet for later games.
    const c = calibrateMarket(Array.from({ length: 12 }, () => sample(60, 50)));
    // Week: (12 x 1.2 + 12 x 1) / 24 = 1.1. Near: (12 x 1.2 + 12 x 1.1) / 24 = 1.15. Far falls back to the week.
    expect(c.factor('recYds', 'near')).toBe(1.15);
    expect(c.factor('recYds', 'far')).toBe(1.1);
    expect(c.factor('passYds', 'near')).toBe(1);
  });

  it('ignores players ESPN projects for almost nothing', () => {
    expect(calibrateMarket([sample(10, 2), sample(8, 3)]).samples).toBe(0);
  });
});

describe('marketAdjustment with calibration', () => {
  it('changes nothing when a line is only as far above ESPN as lines typically are', () => {
    // 72.6 over 60.7 is the same 1.2 premium every near-game line carries: no signal about this player.
    expect(marketAdjustment(wr, { recYds: 72.6 }, halfPpr, 0.5, () => 1.2)).toBeNull();
    // Uncalibrated, the same line would have lifted him.
    expect(marketAdjustment(wr, { recYds: 72.6 }, halfPpr)!.blended).toBe(12.4);
  });
});

describe('kickoffWindow', () => {
  const now = Date.parse('2026-09-21T12:00:00Z');
  it('is near within 36 hours of kickoff, far otherwise or when unknown', () => {
    expect(kickoffWindow('2026-09-22T00:15Z', now)).toBe('near');
    expect(kickoffWindow('2026-09-25T00:15Z', now)).toBe('far');
    expect(kickoffWindow(null, now)).toBe('far');
  });
});