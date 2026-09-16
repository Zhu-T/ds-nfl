import { describe, it, expect } from 'vitest';
import { MATCHUP_LIMIT, applyMatchups, matchupFactor, type MatchupInput } from './adjust.js';
import type { OptimizerPlayer } from '../lineup/optimize.js';

const input = (allowed: number, games = 1): MatchupInput => ({
  opponent: 'HOU',
  home: false,
  allowed,
  average: 18.59,
  rank: 30,
  games,
});

describe('matchupFactor', () => {
  it('is 1 for an average defense, with no games played, or with no average', () => {
    expect(matchupFactor(18.59, 18.59, 1)).toBe(1);
    expect(matchupFactor(30, 18.59, 0)).toBe(1);
    expect(matchupFactor(30, 0, 3)).toBe(1);
  });

  it('counts a defense for little after one game: double the average moves a projection about 10%', () => {
    // (36.84 / 18.59 - 1) weighted 1 / (1 + 4), then halved.
    expect(matchupFactor(36.84, 18.59, 1)).toBe(1.098);
    expect(matchupFactor(22, 20, 1)).toBe(1.01);
  });

  it('trusts a defense more as it plays more games', () => {
    expect(matchupFactor(24, 20, 8)).toBeGreaterThan(matchupFactor(24, 20, 1));
    expect(matchupFactor(16, 20, 8)).toBeLessThan(matchupFactor(16, 20, 1));
  });

  it('never moves a projection more than the limit either way', () => {
    expect(matchupFactor(80, 18, 16)).toBe(1 + MATCHUP_LIMIT);
    expect(matchupFactor(0, 20, 16)).toBe(1 - MATCHUP_LIMIT);
  });
});

describe('applyMatchups', () => {
  const p = (id: string, pts: number, extra: Partial<OptimizerPlayer> = {}): OptimizerPlayer => ({
    gsisId: id,
    name: id,
    position: 'QB',
    projectedPoints: pts,
    available: true,
    ...extra,
  });

  it('scales a projection and records the matchup; players without one are untouched', () => {
    const plain = p('b', 10);
    const [moved, same] = applyMatchups([p('a', 20), plain], new Map([['a', input(36.84)]]));
    expect(moved!.projectedPoints).toBe(22);
    expect(moved!.matchup).toEqual({ ...input(36.84), from: 20, factor: 1.098, pricedByMarket: false });
    expect(same).toBe(plain);
  });

  it('leaves a player the betting market priced as they are, and says so', () => {
    const market = { espn: 18, blended: 20, lines: [] };
    const [priced] = applyMatchups([p('a', 20, { market })], new Map([['a', input(36.84)]]));
    expect(priced!.projectedPoints).toBe(20);
    expect(priced!.matchup).toMatchObject({ factor: 1, pricedByMarket: true, opponent: 'HOU' });
  });
});
