/**
 * A finished week, summarised: each player's actual points beside what was
 * projected, and three totals for your lineup. Pure, so it can be tested.
 */

import { optimizeLineup, type OptimizerPlayer, type RosterSettings } from '@ds-nfl/core';
import type { PlayerResult, ResultOwnerKind, RosterPlayer, WeekResults, WeekSnapshot } from '@ds-nfl/adapters';

export interface WeekInputs {
  readonly leagueKey: string;
  readonly week: number;
  readonly settings: RosterSettings;
  /** Every rostered player that week, with their slot and actual points. */
  readonly rostered: readonly { readonly player: RosterPlayer; readonly ownerKind: 'mine' | 'team' }[];
  /** Unrostered players the snapshot priced, read again for their actual points. */
  readonly others: readonly RosterPlayer[];
  readonly snapshot: WeekSnapshot | null;
  /** Every news finding for the week, and whether it was in use. */
  readonly findings: readonly { readonly playerId: string; readonly status: string; readonly factor: number; readonly summary: string; readonly used: boolean }[];
  readonly pickedIds: ReadonlySet<string>;
  readonly now?: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const scored = (p: RosterPlayer) => p.actualPoints ?? 0;
const STARTING = (slot: string) => slot !== 'BENCH' && slot !== 'IR';

function asOptimizer(p: RosterPlayer, points: number, available: boolean): OptimizerPlayer {
  return {
    gsisId: p.platformPlayerId,
    name: p.name,
    position: p.position,
    eligibleSlots: p.eligibleSlots,
    projectedPoints: Math.max(0, points),
    available,
  };
}

export function summarizeWeek(input: WeekInputs): WeekResults {
  const snap = input.snapshot?.players ?? {};
  const news = new Map(input.findings.map((f) => [f.playerId, f]));
  const row = (p: RosterPlayer, ownerKind: ResultOwnerKind, setSlot?: string): PlayerResult => {
    const app = snap[p.platformPlayerId];
    const f = news.get(p.platformPlayerId);
    return {
      id: p.platformPlayerId,
      name: p.name,
      position: p.position,
      proTeam: p.proTeam,
      ownerKind,
      espn: p.projectedPoints,
      actual: p.actualPoints ?? null,
      ...(setSlot ? { setSlot } : {}),
      ...(app ? { app } : {}),
      ...(f ? { news: { status: f.status, factor: f.factor, summary: f.summary, used: f.used } } : {}),
      ...(input.pickedIds.has(p.platformPlayerId) ? { webPick: true } : {}),
    };
  };

  const mine = input.rostered.filter((r) => r.ownerKind === 'mine').map((r) => r.player);
  return {
    leagueKey: input.leagueKey,
    week: input.week,
    recordedAt: input.now ?? new Date().toISOString(),
    snapshotted: Object.keys(snap).length > 0,
    lineup: mine.length > 0 ? lineupTotals(mine, input.snapshot, input.settings) : null,
    players: [
      ...input.rostered.map(({ player, ownerKind }) => row(player, ownerKind, player.currentSlot)),
      ...input.others.map((p) => row(p, p.pickup ?? 'free-agent')),
    ],
  };
}

/** Your set lineup, the recommended one, and the best possible, all in actual points. */
function lineupTotals(mine: readonly RosterPlayer[], snapshot: WeekSnapshot | null, settings: RosterSettings): NonNullable<WeekResults['lineup']> {
  const snap = snapshot?.players ?? {};
  const set = mine.filter((p) => STARTING(p.currentSlot)).reduce((s, p) => s + scored(p), 0);

  let recommended: number;
  let recommendedFrom: 'app' | 'espn';
  if (mine.some((p) => snap[p.platformPlayerId]?.slot)) {
    recommended = mine.filter((p) => STARTING(snap[p.platformPlayerId]?.slot ?? 'BENCH')).reduce((s, p) => s + scored(p), 0);
    recommendedFrom = 'app';
  } else {
    // Before recording began: the best lineup by ESPN's projections for the week.
    const byId = new Map(mine.map((p) => [p.platformPlayerId, p]));
    const plan = optimizeLineup(mine.map((p) => asOptimizer(p, p.projectedPoints, p.available && p.currentSlot !== 'IR')), settings);
    recommended = plan.starters.reduce((s, a) => s + (a.player ? scored(byId.get(a.player.gsisId)!) : 0), 0);
    recommendedFrom = 'espn';
  }

  const best = optimizeLineup(mine.map((p) => asOptimizer(p, scored(p), true)), settings).projectedPoints;
  return { set: round1(set), recommended: round1(recommended), recommendedFrom, best: round1(best) };
}
