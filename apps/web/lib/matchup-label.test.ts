import { describe, it, expect } from 'vitest';
import { matchupLabel, matchupSentence, versusProjection } from './matchup-label';

const m = { opponent: 'HOU', home: false, ratio: 1.24, rank: 28, teams: 32, games: 1, factor: 1.048, pricedByMarket: false };

describe('matchup labels', () => {
  it('reads the opponent against projections, not a rank of points allowed', () => {
    expect(versusProjection(1.24)).toBe('24% over projection');
    expect(versusProjection(0.7)).toBe('30% under projection');
    expect(versusProjection(1.002)).toBe('as projected');
    expect(matchupLabel(m, 'DST')).toBe('@ HOU: D/STs 24% over projection vs them, ×1.05');
    expect(matchupSentence({ ...m, home: true }, 'DST')).toBe(
      'vs HOU; D/STs have scored 24% over projection against them over 1 game (rank 28 of 32, 1 = toughest), projection ×1.048',
    );
  });
});
