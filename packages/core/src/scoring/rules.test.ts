import { describe, it, expect } from 'vitest';
import { scoreStatLine, round2, type ScoringRule, type ScoringRuleSet } from './rules.js';

function ruleSet(rules: ScoringRule[]): ScoringRuleSet {
  return { rules, unmapped: [], source: { platform: 'test', fetchedAt: 0 } };
}

/** A conventional full-PPR league, expressed the way ESPN encodes yardage. */
const PPR = ruleSet([
  { kind: 'perUnit', stat: 'passYds', points: 0.04 },
  { kind: 'perUnit', stat: 'passTd', points: 4 },
  { kind: 'perUnit', stat: 'passInt', points: -2 },
  { kind: 'perUnit', stat: 'rushYds', points: 0.1 },
  { kind: 'perUnit', stat: 'rushTd', points: 6 },
  { kind: 'perUnit', stat: 'rec', points: 1 },
  { kind: 'perUnit', stat: 'recYds', points: 0.1 },
  { kind: 'perUnit', stat: 'recTd', points: 6 },
  { kind: 'perUnit', stat: 'fumblesLost', points: -2 },
]);

describe('scoreStatLine', () => {
  it('scores a full-PPR receiving line', () => {
    const { total } = scoreStatLine({ rec: 8, recYds: 112, recTd: 1 }, 'WR', PPR);
    expect(total).toBe(8 + 11.2 + 6);
  });

  it('scores a passing line including negative rules', () => {
    const { total } = scoreStatLine(
      { passYds: 317, passTd: 2, passInt: 1, rushYds: 14 },
      'QB',
      PPR,
    );
    // 12.68 + 8 - 2 + 1.4
    expect(total).toBe(20.08);
  });

  it('distinguishes 4pt from 6pt passing touchdowns', () => {
    const line = { passYds: 300, passTd: 3 };
    const sixPt = ruleSet([
      { kind: 'perUnit', stat: 'passYds', points: 0.04 },
      { kind: 'perUnit', stat: 'passTd', points: 6 },
    ]);
    expect(scoreStatLine(line, 'QB', PPR).total).toBe(24);
    expect(scoreStatLine(line, 'QB', sixPt).total).toBe(30);
  });

  it('honours half-PPR and standard reception values', () => {
    const line = { rec: 7, recYds: 60 };
    const half = ruleSet([
      { kind: 'perUnit', stat: 'rec', points: 0.5 },
      { kind: 'perUnit', stat: 'recYds', points: 0.1 },
    ]);
    const standard = ruleSet([{ kind: 'perUnit', stat: 'recYds', points: 0.1 }]);

    expect(scoreStatLine(line, 'WR', PPR).total).toBe(13);
    expect(scoreStatLine(line, 'WR', half).total).toBe(9.5);
    expect(scoreStatLine(line, 'WR', standard).total).toBe(6);
  });

  it('applies a threshold bonus only at or above the threshold', () => {
    const rules = ruleSet([
      { kind: 'perUnit', stat: 'rushYds', points: 0.1 },
      { kind: 'threshold', stat: 'rushYds', points: 3, atLeast: 100 },
    ]);
    expect(scoreStatLine({ rushYds: 99 }, 'RB', rules).total).toBe(9.9);
    expect(scoreStatLine({ rushYds: 100 }, 'RB', rules).total).toBe(13);
    expect(scoreStatLine({ rushYds: 140 }, 'RB', rules).total).toBe(17);
  });

  it('scopes a rule to positions (TE premium)', () => {
    const tePremium = ruleSet([
      { kind: 'perUnit', stat: 'rec', points: 1 },
      { kind: 'perUnit', stat: 'rec', points: 0.5, positions: ['TE'] },
    ]);
    expect(scoreStatLine({ rec: 6 }, 'WR', tePremium).total).toBe(6);
    expect(scoreStatLine({ rec: 6 }, 'TE', tePremium).total).toBe(9);
  });

  it('awards perN only for completed blocks when rounding is floor', () => {
    const rules = ruleSet([
      { kind: 'perN', stat: 'rushYds', points: 1, per: 10, rounding: 'floor' },
    ]);
    expect(scoreStatLine({ rushYds: 29 }, 'RB', rules).total).toBe(2);
    expect(scoreStatLine({ rushYds: 30 }, 'RB', rules).total).toBe(3);
  });

  it('scores D/ST points-allowed bands, including a shutout at value zero', () => {
    const rules = ruleSet([
      {
        kind: 'bucket',
        stat: 'dstPointsAllowed',
        bands: [
          { max: 0, points: 10 },
          { max: 6, points: 7 },
          { max: 13, points: 4 },
          { max: 20, points: 1 },
          { max: 27, points: 0 },
          { max: null, points: -4 },
        ],
      },
      { kind: 'perUnit', stat: 'dstSack', points: 1 },
    ]);

    // A shutout is the top band — it must score even though the stat is 0.
    expect(scoreStatLine({ dstPointsAllowed: 0, dstSack: 3 }, 'DST', rules).total).toBe(13);
    expect(scoreStatLine({ dstPointsAllowed: 17, dstSack: 2 }, 'DST', rules).total).toBe(3);
    expect(scoreStatLine({ dstPointsAllowed: 45, dstSack: 1 }, 'DST', rules).total).toBe(-3);
  });

  it('returns a breakdown that sums to the total', () => {
    const { total, parts } = scoreStatLine(
      { rec: 5, recYds: 83, recTd: 1, fumblesLost: 1 },
      'WR',
      PPR,
    );
    expect(round2(parts.reduce((s, p) => s + p.points, 0))).toBe(total);
    expect(parts.map((p) => p.stat)).toEqual(['rec', 'recYds', 'recTd', 'fumblesLost']);
  });

  it('treats absent stats as zero rather than throwing', () => {
    expect(scoreStatLine({}, 'RB', PPR).total).toBe(0);
  });

  it('ignores unmapped platform items when scoring', () => {
    const withUnmapped: ScoringRuleSet = {
      ...PPR,
      unmapped: [{ platformStatId: '999', points: 5, note: 'unknown ESPN statId' }],
    };
    // Unmapped items are surfaced to the user, not silently scored.
    expect(scoreStatLine({ rec: 3 }, 'WR', withUnmapped).total).toBe(3);
    expect(withUnmapped.unmapped).toHaveLength(1);
  });

  it('avoids floating-point noise in totals', () => {
    const { total } = scoreStatLine({ recYds: 3, rec: 0 }, 'WR', PPR);
    expect(total).toBe(0.3);
  });
});
