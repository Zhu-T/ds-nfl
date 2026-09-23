import { describe, it, expect } from 'vitest';
import { MATCHUP_LIMIT, applyMatchups, matchupFactor, opponentSplits, type MatchupInput, type OpponentGame } from './adjust.js';
import type { OptimizerPlayer } from '../lineup/optimize.js';

const input = (ratio: number, games = 1): MatchupInput => ({ opponent: 'HOU', home: false, ratio, rank: 30, teams: 32, games });

describe('matchupFactor', () => {
  it('is 1 when players have scored as projected, or with no games played', () => {
    expect(matchupFactor(1, 3)).toBe(1);
    expect(matchupFactor(1.8, 0)).toBe(1);
  });

  it('counts an opponent for little after one game: 50% over projection moves the next one 10%', () => {
    // (1.5 - 1) weighted 1 / (1 + 4).
    expect(matchupFactor(1.5, 1)).toBe(1.1);
    expect(matchupFactor(0.75, 1)).toBe(0.95);
  });

  it('trusts an opponent more as it plays more games', () => {
    expect(matchupFactor(1.2, 8)).toBeGreaterThan(matchupFactor(1.2, 1));
    expect(matchupFactor(0.8, 8)).toBeLessThan(matchupFactor(0.8, 1));
  });

  it('never moves a projection more than the limit either way, even when D/STs scored below zero', () => {
    expect(matchupFactor(4, 16)).toBe(1 + MATCHUP_LIMIT);
    expect(matchupFactor(-0.5, 16)).toBe(1 - MATCHUP_LIMIT);
  });
});

describe('opponentSplits', () => {
  const g = (week: number, opponent: string, actual: number, projected: number): OpponentGame => ({ week, position: 'DST', opponent, actual, projected });

  it('pools each opponent across its games and ranks the toughest first', () => {
    const splits = opponentSplits([
      g(1, 'HOU', 14, 7),
      g(2, 'HOU', 2, 5), // 16 of 12 projected across two games
      g(1, 'KC', 3, 6),
      g(1, 'CIN', 8, 8),
      g(1, 'NYJ', 9, 0.5), // barely projected: left out
    ]).get('DST')!;
    expect(splits.get('HOU')).toEqual({ ratio: 1.333, rank: 3, teams: 3, games: 2 });
    expect(splits.get('KC')).toEqual({ ratio: 0.5, rank: 1, teams: 3, games: 1 });
    expect(splits.get('CIN')!.rank).toBe(2);
    expect(splits.has('NYJ')).toBe(false);
  });
});

describe('applyMatchups', () => {
  const p = (id: string, pts: number, extra: Partial<OptimizerPlayer> = {}): OptimizerPlayer => ({
    gsisId: id,
    name: id,
    position: 'DST',
    projectedPoints: pts,
    available: true,
    ...extra,
  });

  it('scales a projection and records the matchup; players without one are untouched', () => {
    const plain = p('b', 10);
    const [moved, same] = applyMatchups([p('a', 6), plain], new Map([['a', input(2)]]));
    expect(moved!.projectedPoints).toBe(7.2);
    expect(moved!.matchup).toEqual({ ...input(2), from: 6, factor: 1.2, pricedByMarket: false });
    expect(same).toBe(plain);
  });

  it('leaves a player the betting market priced as they are, and says so', () => {
    const market = { espn: 18, blended: 20, lines: [] };
    const [priced] = applyMatchups([p('a', 20, { market })], new Map([['a', input(1.5)]]));
    expect(priced!.projectedPoints).toBe(20);
    expect(priced!.matchup).toMatchObject({ factor: 1, pricedByMarket: true, opponent: 'HOU' });
  });
});
