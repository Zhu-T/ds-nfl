import { describe, it, expect } from 'vitest';
import { parseEspnScoring, scoreEspnStats, pprLabelFromRules } from './scoring.js';
import { activeLeague } from '../credentials.js';

describe('parseEspnScoring', () => {
  it('reads statId to points, and per-position overrides separately', () => {
    const rules = parseEspnScoring([
      { statId: 3, points: 0.04 },
      { statId: 53, points: 0.5, pointsOverrides: { '4': 1 } }, // TE premium
    ]);
    expect(rules.base.get(3)).toBe(0.04);
    expect(rules.base.get(53)).toBe(0.5);
    expect(rules.overrides.get(53)).toEqual({ '4': 1 });
    expect(rules.overrides.has(3)).toBe(false);
  });
});

describe('scoreEspnStats', () => {
  // Mirrors the real league: half PPR, and a non-standard 5-point passing TD.
  const rules = parseEspnScoring([
    { statId: 3, points: 0.04 }, // passing yards
    { statId: 4, points: 5 }, // passing TD
    { statId: 20, points: -2 }, // interception
    { statId: 42, points: 0.1 }, // receiving yards
    { statId: 53, points: 0.5, pointsOverrides: { '4': 1 } }, // receptions, TE premium
  ]);

  it('scores a stat line as the dot product of values and points', () => {
    const score = scoreEspnStats({ '3': 300, '4': 2, '20': 1 }, 1, rules);
    expect(score.total).toBe(12 + 10 - 2);
  });

  it('applies a per-position override only to that position', () => {
    const line = { '53': 6, '42': 70 };
    expect(scoreEspnStats(line, 3, rules).total).toBe(3 + 7); // WR: half point
    expect(scoreEspnStats(line, 4, rules).total).toBe(6 + 7); // TE: full point
  });

  it('ignores stats the league does not score', () => {
    expect(scoreEspnStats({ '999': 50 }, 1, rules).total).toBe(0);
  });

  it('reports the contributing stats so a projection can be explained', () => {
    const { parts, total } = scoreEspnStats({ '3': 250, '4': 1 }, 1, rules);
    expect(parts.map((p) => p.statId).sort()).toEqual([3, 4]);
    expect(Math.round(parts.reduce((s, p) => s + p.points, 0) * 100) / 100).toBe(total);
  });

  it('labels PPR variants from the receptions rule', () => {
    expect(pprLabelFromRules(parseEspnScoring([{ statId: 53, points: 1 }]))).toBe('Full PPR');
    expect(pprLabelFromRules(parseEspnScoring([{ statId: 53, points: 0.5 }]))).toBe('0.5 PPR');
    expect(pprLabelFromRules(parseEspnScoring([]))).toBe('Standard');
  });
});

/**
 * The real proof. ESPN computes `appliedTotal` itself for every stats entry, so
 * scoring every entry in the league and comparing is an exact check of the whole
 * approach — including per-position overrides and any rule we have never seen.
 */
const espn = activeLeague();
const suite = espn ? describe : describe.skip;

suite('scoring matches ESPN appliedTotal on the live league', () => {
  it('reproduces every appliedTotal in the league', async () => {
    const headers = {
      Cookie: `espn_s2=${espn!.espnS2}; SWID=${espn!.swid}`,
      'User-Agent': 'Mozilla/5.0',
    };
    const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${espn!.season}/segments/0/leagues/${espn!.leagueId}`;

    const settings = (await (await fetch(`${base}?view=mSettings`, { headers })).json()) as any;
    const rules = parseEspnScoring(settings.settings.scoringSettings.scoringItems);
    expect(rules.itemCount).toBeGreaterThan(10);

    const rosters = (await (await fetch(`${base}?view=mRoster`, { headers })).json()) as any;

    let checked = 0;
    const mismatches: string[] = [];

    for (const team of rosters.teams ?? []) {
      for (const entry of team.roster?.entries ?? []) {
        const player = entry.playerPoolEntry?.player;
        if (!player) continue;
        for (const stat of player.stats ?? []) {
          if (typeof stat.appliedTotal !== 'number' || !stat.stats) continue;
          const ours = scoreEspnStats(stat.stats, player.defaultPositionId, rules);
          checked++;
          if (Math.abs(ours.total - stat.appliedTotal) > 0.02) {
            mismatches.push(
              `${player.fullName} pos=${player.defaultPositionId} espn=${stat.appliedTotal.toFixed(2)} ours=${ours.total.toFixed(2)}`,
            );
          }
        }
      }
    }

    expect(checked).toBeGreaterThan(100);
    expect(mismatches.slice(0, 5)).toEqual([]);
  }, 120_000);
});
