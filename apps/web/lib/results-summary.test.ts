import { describe, it, expect } from 'vitest';
import type { RosterPlayer, WeekSnapshot } from '@ds-nfl/adapters';
import type { LineupSlot, RosterSettings } from '@ds-nfl/core';
import { summarizeWeek, type WeekInputs } from './results-summary';

const rs: RosterSettings = { slots: { QB: 1, RB: 1 }, benchSize: 4, irSize: 0 };

function p(id: string, position: 'QB' | 'RB', slot: string, espn: number, actual?: number): RosterPlayer {
  return {
    platformPlayerId: id,
    name: id,
    position,
    eligibleSlots: [position as LineupSlot],
    currentSlot: slot as LineupSlot,
    projectedPoints: espn,
    available: true,
    proTeam: 'DET',
    locked: true,
    ...(actual !== undefined ? { actualPoints: actual } : {}),
  };
}

// You started A and C; B, on your bench, outscored A.
const mine = [p('A', 'QB', 'QB', 18, 20), p('B', 'QB', 'BENCH', 15, 25), p('C', 'RB', 'RB', 12, 10), p('D', 'RB', 'BENCH', 5, 3)];
const base: WeekInputs = {
  leagueKey: 'espn:1:2026',
  week: 1,
  settings: rs,
  rostered: [...mine.map((player) => ({ player, ownerKind: 'mine' as const })), { player: p('E', 'RB', 'RB', 14, 21), ownerKind: 'team' }],
  others: [{ ...p('F', 'RB', 'BENCH', 6), pickup: 'waivers' }],
  snapshot: null,
  findings: [{ playerId: 'C', status: 'questionable', factor: 0.8, summary: 'Limited.', used: true }],
  pickedIds: new Set(['F']),
  now: 'now',
};

describe('summarizeWeek', () => {
  it("totals the set lineup, ESPN's best lineup before recording began, and the best possible", () => {
    const r = summarizeWeek(base);
    expect(r.lineup).toEqual({ set: 30, recommended: 30, recommendedFrom: 'espn', best: 35 });
    expect(r.snapshotted).toBe(false);
  });

  it("uses the app's recommended slots when it recorded them before kickoff", () => {
    const snapshot: WeekSnapshot = {
      leagueKey: 'espn:1:2026',
      week: 1,
      updatedAt: 'then',
      players: {
        B: { id: 'B', name: 'B', position: 'QB', proTeam: 'DET', ownerKind: 'mine', espn: 15, projected: 19, slot: 'QB', capturedAt: 'then', beforeKickoff: true },
        A: { id: 'A', name: 'A', position: 'QB', proTeam: 'DET', ownerKind: 'mine', espn: 18, projected: 17, slot: 'BENCH', capturedAt: 'then', beforeKickoff: true },
        C: { id: 'C', name: 'C', position: 'RB', proTeam: 'DET', ownerKind: 'mine', espn: 12, projected: 9.6, slot: 'RB', capturedAt: 'then', beforeKickoff: true },
      },
    };
    const r = summarizeWeek({ ...base, snapshot });
    expect(r.lineup).toEqual({ set: 30, recommended: 35, recommendedFrom: 'app', best: 35 });
    expect(r.snapshotted).toBe(true);
    expect(r.players.find((x) => x.id === 'B')!.app!.projected).toBe(19);
  });

  it('keeps every player with actual points, slot, news, and web pick', () => {
    const rows = summarizeWeek(base).players;
    expect(rows.map((x) => [x.id, x.ownerKind, x.setSlot ?? null, x.espn, x.actual])).toEqual([
      ['A', 'mine', 'QB', 18, 20],
      ['B', 'mine', 'BENCH', 15, 25],
      ['C', 'mine', 'RB', 12, 10],
      ['D', 'mine', 'BENCH', 5, 3],
      ['E', 'team', 'RB', 14, 21],
      ['F', 'waivers', null, 6, null],
    ]);
    expect(rows.find((x) => x.id === 'C')!.news).toEqual({ status: 'questionable', factor: 0.8, summary: 'Limited.', used: true });
    expect(rows.find((x) => x.id === 'F')!.webPick).toBe(true);
  });
});
