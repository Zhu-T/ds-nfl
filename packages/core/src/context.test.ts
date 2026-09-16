import { describe, it, expect } from 'vitest';
import { valuationKey, recommendationKey, type LeagueContext, type TeamContext } from './context.js';
import { scoreStatLine, type ScoringRuleSet } from './scoring/rules.js';
import { optimizeLineup, type OptimizerPlayer } from './lineup/optimize.js';
import type { RosterSettings } from './types.js';

const season = { season: 2026, week: 1 };

function rules(rec: number): ScoringRuleSet {
  return {
    rules: [
      { kind: 'perUnit', stat: 'recYds', points: 0.1 },
      { kind: 'perUnit', stat: 'recTd', points: 6 },
      ...(rec > 0 ? ([{ kind: 'perUnit', stat: 'rec', points: rec }] as const) : []),
      { kind: 'perUnit', stat: 'passYds', points: 0.04 },
      { kind: 'perUnit', stat: 'passTd', points: 4 },
    ],
    unmapped: [],
    source: { platform: 'test', fetchedAt: 0 },
  };
}

function league(id: string, scoring: ScoringRuleSet, roster: RosterSettings): LeagueContext {
  return {
    leagueId: id,
    platform: 'espn',
    season,
    scoring,
    roster,
    teamCount: 12,
    adpFormat: 'ppr',
  };
}

const STANDARD_ROSTER: RosterSettings = {
  slots: { QB: 1, RB: 1, WR: 1, FLEX: 1 },
  benchSize: 6,
  irSize: 1,
};
const SUPERFLEX_ROSTER: RosterSettings = {
  slots: { QB: 1, RB: 1, WR: 1, OP: 1 },
  benchSize: 6,
  irSize: 1,
};

describe('league-scoped valuation', () => {
  it('values the same player differently in PPR and standard leagues', () => {
    const line = { rec: 9, recYds: 85 };
    const ppr = league('espn:1:2026', rules(1), STANDARD_ROSTER);
    const standard = league('espn:2:2026', rules(0), STANDARD_ROSTER);

    const inPpr = scoreStatLine(line, 'WR', ppr.scoring).total;
    const inStandard = scoreStatLine(line, 'WR', standard.scoring).total;

    expect(inPpr).toBe(17.5);
    expect(inStandard).toBe(8.5);
    // The stat line is a league-independent fact; the points are not.
    expect(inPpr).not.toBe(inStandard);
  });

  it('keys valuations by league so the same player cannot collide across leagues', () => {
    const a = league('espn:1:2026', rules(1), STANDARD_ROSTER);
    const b = league('sleeper:9:2026', rules(0), STANDARD_ROSTER);

    expect(valuationKey(a, 'player-1')).not.toBe(valuationKey(b, 'player-1'));
    expect(valuationKey(a, 'player-1', 3)).not.toBe(valuationKey(a, 'player-1', 4));
  });
});

describe('team-scoped recommendation', () => {
  const qb2 = (): OptimizerPlayer => ({
    gsisId: 'qb2',
    name: 'Backup QB',
    position: 'QB',
    projectedPoints: 19,
    available: true,
  });
  const roster: OptimizerPlayer[] = [
    { gsisId: 'qb1', name: 'Starter QB', position: 'QB', projectedPoints: 24, available: true },
    qb2(),
    { gsisId: 'rb1', name: 'RB', position: 'RB', projectedPoints: 14, available: true },
    { gsisId: 'wr1', name: 'WR', position: 'WR', projectedPoints: 13, available: true },
    { gsisId: 'wr2', name: 'WR2', position: 'WR', projectedPoints: 11, available: true },
  ];

  it('produces a different optimal lineup under superflex than under a standard flex', () => {
    const flex = optimizeLineup(roster, STANDARD_ROSTER);
    const superflex = optimizeLineup(roster, SUPERFLEX_ROSTER);

    // A FLEX cannot take a QB, so the backup QB is benched; an OP slot can.
    expect(flex.starters.find((s) => s.slot === 'FLEX')?.player?.name).toBe('WR2');
    expect(superflex.starters.find((s) => s.slot === 'OP')?.player?.name).toBe('Backup QB');
    expect(superflex.projectedPoints).toBeGreaterThan(flex.projectedPoints);
  });

  it('keys recommendations by team, so two teams in one league stay separate', () => {
    const lg = league('espn:1:2026', rules(1), STANDARD_ROSTER);
    const mine: TeamContext = { league: lg, teamId: '4', isMine: true, roster };
    const theirs: TeamContext = { league: lg, teamId: '7', isMine: false, roster };

    expect(recommendationKey(mine, 'lineup', 1)).not.toBe(recommendationKey(theirs, 'lineup', 1));
  });

  it('models an opponent team, which the trade finder needs', () => {
    const lg = league('espn:1:2026', rules(1), STANDARD_ROSTER);
    const opponent: TeamContext = { league: lg, teamId: '7', isMine: false, roster };

    // The same optimizer runs from their side to test whether they would accept.
    const theirBest = optimizeLineup(opponent.roster, opponent.league.roster);
    expect(opponent.isMine).toBe(false);
    expect(theirBest.projectedPoints).toBeGreaterThan(0);
  });
});
