import { describe, it, expect } from 'vitest';
import { FORM_LIMIT, applyForm, formFactor, type FormInput } from './adjust.js';
import type { OptimizerPlayer } from '../lineup/optimize.js';

describe('formFactor', () => {
  it('is 1 for a player scoring what they are projected, or with no games or projection', () => {
    expect(formFactor(17, 17, 2)).toBe(1);
    expect(formFactor(30, 17, 0)).toBe(1);
    expect(formFactor(30, 0, 2)).toBe(1);
  });

  it('counts one game for little: Trevor Lawrence, 30.1 scored against 17.0 projected', () => {
    // (30.1 / 17 - 1) weighted 1 / (1 + 3), then halved: about +9.6%.
    expect(formFactor(30.1, 17, 1)).toBe(1.096);
    expect(formFactor(19, 17, 1)).toBe(1.015);
  });

  it('trusts a player more as they play more games', () => {
    expect(formFactor(24, 20, 6)).toBeGreaterThan(formFactor(24, 20, 1));
    expect(formFactor(14, 20, 6)).toBeLessThan(formFactor(14, 20, 1));
  });

  it('never moves a projection more than the limit either way', () => {
    expect(formFactor(60, 10, 10)).toBe(1 + FORM_LIMIT);
    expect(formFactor(0.1, 20, 10)).toBe(1 - FORM_LIMIT);
  });
});

describe('applyForm', () => {
  const p = (id: string, pts: number, extra: Partial<OptimizerPlayer> = {}): OptimizerPlayer => ({
    gsisId: id,
    name: id,
    position: 'QB',
    projectedPoints: pts,
    available: true,
    ...extra,
  });
  const input: FormInput = { average: 30.1, games: 1 };

  it('scales a projection and records the form; a player with no games is untouched', () => {
    const fresh = p('b', 12);
    const [moved, same] = applyForm(
      [p('a', 17), fresh],
      new Map([
        ['a', input],
        ['b', { average: 0, games: 0 }],
      ]),
    );
    expect(moved!.projectedPoints).toBe(18.6);
    expect(moved!.form).toEqual({ average: 30.1, games: 1, from: 17, factor: 1.096, pricedByMarket: false });
    expect(same).toBe(fresh);
  });

  it('leaves a player the betting market priced as they are, and says so', () => {
    const market = { espn: 16, blended: 17, lines: [] };
    const [priced] = applyForm([p('a', 17, { market })], new Map([['a', input]]));
    expect(priced!.projectedPoints).toBe(17);
    expect(priced!.form).toMatchObject({ factor: 1, pricedByMarket: true, average: 30.1 });
  });
});
