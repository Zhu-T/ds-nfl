import { describe, it, expect } from 'vitest';
import { hungarian } from './hungarian.js';
import { optimizeLineup, diffLineup, type OptimizerPlayer, type SlotAssignment } from './optimize.js';
import { expandStartingSlots, isEligible, type LineupSlot, type Position, type RosterSettings } from '../types.js';

function player(
  name: string,
  position: Position,
  projectedPoints: number,
  available = true,
): OptimizerPlayer {
  return { gsisId: name, name, position, projectedPoints, available };
}

function settings(slots: RosterSettings['slots']): RosterSettings {
  return { slots, benchSize: 6, irSize: 1 };
}

/**
 * The natural greedy implementation, and the one this optimizer exists to beat:
 * walk the starting slots in order, dropping the best eligible player into each.
 */
function greedyLineup(players: readonly OptimizerPlayer[], rs: RosterSettings): number {
  const used = new Set<string>();
  let total = 0;
  for (const slot of expandStartingSlots(rs)) {
    const best = players
      .filter((p) => p.available && !used.has(p.gsisId) && isEligible(p, slot))
      .sort((a, b) => b.projectedPoints - a.projectedPoints)[0];
    if (best) {
      used.add(best.gsisId);
      total += best.projectedPoints;
    }
  }
  return total;
}

/** Exhaustive search over injective slot->player mappings. Only for small cases. */
function bruteForceLineup(players: readonly OptimizerPlayer[], rs: RosterSettings): number {
  const slots = expandStartingSlots(rs);
  const pool = players.filter((p) => p.available);
  let best = 0;

  const walk = (slotIdx: number, used: Set<string>, total: number): void => {
    if (slotIdx === slots.length) {
      best = Math.max(best, total);
      return;
    }
    const slot = slots[slotIdx]!;
    walk(slotIdx + 1, used, total); // leaving a slot empty is always allowed
    for (const p of pool) {
      if (used.has(p.gsisId) || !isEligible(p, slot)) continue;
      used.add(p.gsisId);
      walk(slotIdx + 1, used, total + p.projectedPoints);
      used.delete(p.gsisId);
    }
  };
  walk(0, new Set(), 0);
  return best;
}

describe('hungarian', () => {
  it('solves a known minimal assignment', () => {
    const cost = [
      [4, 1, 3],
      [2, 0, 5],
      [3, 2, 2],
    ];
    const assign = hungarian(cost);
    const total = assign.reduce((s, col, row) => s + cost[row]![col]!, 0);
    expect(total).toBe(5); // 1 + 2 + 2
    expect(new Set(assign).size).toBe(3); // every column used once
  });

  it('handles rectangular matrices with more columns than rows', () => {
    const cost = [
      [5, 2, 9, 1],
      [8, 3, 4, 7],
    ];
    const assign = hungarian(cost);
    expect(assign).toHaveLength(2);
    expect(new Set(assign).size).toBe(2);
    expect(assign.reduce((s, col, row) => s + cost[row]![col]!, 0)).toBe(4); // 1 + 3
  });

  it('rejects matrices with fewer columns than rows', () => {
    expect(() => hungarian([[1, 2], [3, 4], [5, 6]])).toThrow(/cols >= rows/);
  });

  it('matches brute force on random matrices', () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (let trial = 0; trial < 60; trial++) {
      const n = 1 + Math.floor(rand() * 5);
      const m = n + Math.floor(rand() * 3);
      const cost = Array.from({ length: n }, () =>
        Array.from({ length: m }, () => Math.floor(rand() * 40) - 10),
      );

      const assign = hungarian(cost);
      const got = assign.reduce((s, col, row) => s + cost[row]![col]!, 0);

      // exhaustive minimum over injective row->col mappings
      let best = Infinity;
      const walk = (row: number, used: Set<number>, total: number): void => {
        if (row === n) {
          best = Math.min(best, total);
          return;
        }
        for (let col = 0; col < m; col++) {
          if (used.has(col)) continue;
          used.add(col);
          walk(row + 1, used, total + cost[row]![col]!);
          used.delete(col);
        }
      };
      walk(0, new Set(), 0);

      expect(got).toBe(best);
    }
  });
});

describe('optimizeLineup', () => {
  it('fills dedicated slots with the right positions', () => {
    const rs = settings({ QB: 1, RB: 2, WR: 2, TE: 1 });
    const solution = optimizeLineup(
      [
        player('Josh', 'QB', 22),
        player('Bijan', 'RB', 18),
        player('Saquon', 'RB', 16),
        player('Jamarr', 'WR', 20),
        player('Puka', 'WR', 15),
        player('Bowers', 'TE', 12),
        player('Benchwarmer', 'RB', 3),
      ],
      rs,
    );

    expect(solution.projectedPoints).toBe(103);
    expect(solution.bench.map((p) => p.name)).toEqual(['Benchwarmer']);
    for (const a of solution.starters) expect(a.player).not.toBeNull();
  });

  it('beats greedy when a flex slot is filled before a more restrictive one', () => {
    // FLEX (RB/WR/TE) is expanded before WR_TE, so a slot-order greedy puts the
    // WR in FLEX and then has nobody left for WR_TE.
    const rs = settings({ FLEX: 1, WR_TE: 1 });
    const players = [player('Elite WR', 'WR', 25), player('Solid RB', 'RB', 20)];

    expect(greedyLineup(players, rs)).toBe(25);
    expect(optimizeLineup(players, rs).projectedPoints).toBe(45);
  });

  it('never scores below greedy, and always equals brute force', () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const positions: Position[] = ['QB', 'RB', 'WR', 'TE'];
    const slotSets: RosterSettings['slots'][] = [
      { RB: 1, WR: 1, FLEX: 1 },
      { QB: 1, FLEX: 1, OP: 1 },
      { FLEX: 1, WR_TE: 1, RB_WR: 1 },
      { RB: 2, FLEX: 1 },
    ];

    for (let trial = 0; trial < 80; trial++) {
      const rs = settings(slotSets[trial % slotSets.length]!);
      const players = Array.from({ length: 3 + Math.floor(rand() * 4) }, (_, i) =>
        player(
          `p${i}`,
          positions[Math.floor(rand() * positions.length)]!,
          Math.floor(rand() * 30),
          rand() > 0.15,
        ),
      );

      const optimal = optimizeLineup(players, rs).projectedPoints;
      expect(optimal).toBeGreaterThanOrEqual(greedyLineup(players, rs));
      expect(optimal).toBeCloseTo(bruteForceLineup(players, rs), 6);
    }
  });

  it('never starts an unavailable player', () => {
    const rs = settings({ RB: 1, FLEX: 1 });
    const solution = optimizeLineup(
      [
        { ...player('Injured Star', 'RB', 30, false), unavailableReason: 'OUT' },
        player('Healthy Backup', 'RB', 8),
        player('Bye Week WR', 'WR', 25, false),
      ],
      rs,
    );

    const startedNames = solution.starters.filter((s) => s.player).map((s) => s.player!.name);
    expect(startedNames).toEqual(['Healthy Backup']);
    expect(solution.projectedPoints).toBe(8);
    expect(solution.bench.map((p) => p.name)).toContain('Injured Star');
  });

  it('respects platform-declared eligibility over the position fallback', () => {
    const rs = settings({ RB: 1, WR: 1 });
    // A gadget player listed as RB but declared WR-eligible by the platform.
    const gadget: OptimizerPlayer = {
      ...player('Gadget', 'RB', 20),
      eligibleSlots: ['WR', 'FLEX'],
    };
    const solution = optimizeLineup([gadget, player('Plain RB', 'RB', 9)], rs);

    const wrSlot = solution.starters.find((s) => s.slot === 'WR');
    expect(wrSlot?.player?.name).toBe('Gadget');
    expect(solution.projectedPoints).toBe(29);
  });

  it('leaves a slot empty when nobody is eligible', () => {
    const rs = settings({ QB: 1, K: 1 });
    const solution = optimizeLineup([player('Josh', 'QB', 22)], rs);

    expect(solution.starters.find((s) => s.slot === 'K')?.player).toBeNull();
    expect(solution.projectedPoints).toBe(22);
  });

  it('keeps a locked player in their slot even when a better option is free', () => {
    // Once a game kicks off the platform refuses any move involving that player,
    // so optimizing around them produces advice that cannot be executed.
    const rs = settings({ RB: 1 });
    const locked: OptimizerPlayer = { ...player('Locked Scrub', 'RB', 3), lockedToSlot: 'RB' };
    const better = player('Free Star', 'RB', 25);

    const solution = optimizeLineup([locked, better], rs);
    expect(solution.starters[0]?.player?.name).toBe('Locked Scrub');
    expect(solution.projectedPoints).toBe(3);
    expect(solution.bench.map((b) => b.name)).toContain('Free Star');
  });

  it('still optimizes the slots that are not locked', () => {
    const rs = settings({ RB: 1, WR: 1 });
    const lockedRb: OptimizerPlayer = { ...player('Locked RB', 'RB', 4), lockedToSlot: 'RB' };
    const solution = optimizeLineup(
      [lockedRb, player('Good WR', 'WR', 18), player('Bad WR', 'WR', 2)],
      rs,
    );

    expect(solution.starters.find((s) => s.slot === 'RB')?.player?.name).toBe('Locked RB');
    expect(solution.starters.find((s) => s.slot === 'WR')?.player?.name).toBe('Good WR');
    expect(solution.projectedPoints).toBe(22);
  });

  it('reports nothing to change when every slot is locked', () => {
    const rs = settings({ RB: 1, WR: 1 });
    const players: OptimizerPlayer[] = [
      { ...player('A', 'RB', 10), lockedToSlot: 'RB' },
      { ...player('B', 'WR', 8), lockedToSlot: 'WR' },
      player('Benched Star', 'WR', 30),
    ];
    const solution = optimizeLineup(players, rs);
    const diff = diffLineup(solution.starters, solution);

    expect(solution.projectedPoints).toBe(18);
    expect(diff.alreadyOptimal).toBe(true);
    expect(diff.slotsChanged).toBe(0);
  });

  it('does not start a player projected below zero', () => {
    const rs = settings({ QB: 1 });
    const solution = optimizeLineup([player('Turnover Machine', 'QB', -3)], rs);
    expect(solution.projectedPoints).toBe(0);
  });
});

describe('diffLineup', () => {
  const rs = settings({ RB: 1, FLEX: 1 });

  it('reports no moves when the lineup is already optimal', () => {
    const players = [player('A', 'RB', 20), player('B', 'WR', 18)];
    const optimal = optimizeLineup(players, rs);
    const diff = diffLineup(optimal.starters, optimal);

    expect(diff.alreadyOptimal).toBe(true);
    expect(diff.moves).toEqual([]);
    expect(diff.pointsGained).toBe(0);
  });

  it('counts one swap as one change, not two', () => {
    // A swap produces two moves (one in, one out) but changes a single slot.
    // Reporting "2 changes" for one substitution is what this guards against.
    const starter = player('Starter', 'RB', 22);
    const scrub = player('Scrub', 'RB', 4);
    const optimal = optimizeLineup([starter, scrub], settings({ RB: 1 }));

    const current: SlotAssignment[] = [{ slot: 'RB' as LineupSlot, slotIndex: 0, player: scrub }];
    const diff = diffLineup(current, optimal);

    expect(diff.moves).toHaveLength(2);
    expect(diff.slotsChanged).toBe(1);
  });

  it('reports zero slots changed when nothing moves', () => {
    const players = [player('A', 'RB', 20), player('B', 'WR', 18)];
    const optimal = optimizeLineup(players, rs);
    expect(diffLineup(optimal.starters, optimal).slotsChanged).toBe(0);
  });

  it('counts each changed slot separately', () => {
    const rs2 = settings({ RB: 2 });
    const good1 = player('Good1', 'RB', 20);
    const good2 = player('Good2', 'RB', 19);
    const bad1 = player('Bad1', 'RB', 3);
    const bad2 = player('Bad2', 'RB', 2);
    const optimal = optimizeLineup([good1, good2, bad1, bad2], rs2);

    const current: SlotAssignment[] = [
      { slot: 'RB' as LineupSlot, slotIndex: 0, player: bad1 },
      { slot: 'RB' as LineupSlot, slotIndex: 1, player: bad2 },
    ];
    expect(diffLineup(current, optimal).slotsChanged).toBe(2);
  });

  it('reports the moves and the points gained', () => {
    const good = player('Starter', 'RB', 22);
    const weak = player('Scrub', 'RB', 4);
    const optimal = optimizeLineup([good, weak], rs);

    const current: SlotAssignment[] = [
      { slot: 'RB' as LineupSlot, slotIndex: 0, player: weak },
      { slot: 'FLEX' as LineupSlot, slotIndex: 1, player: null },
    ];
    const diff = diffLineup(current, optimal);

    expect(diff.alreadyOptimal).toBe(false);
    expect(diff.pointsGained).toBe(22);
    expect(diff.moves.some((m) => m.player.name === 'Starter' && m.from === 'BENCH')).toBe(true);
  });
});
