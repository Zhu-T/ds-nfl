/**
 * Lineup optimization.
 *
 * With FLEX/OP slots this is a bipartite assignment problem, not a sort. Greedy
 * "best player into the best slot" is provably wrong in exactly the cases that
 * matter: it will drop your WR1 into FLEX and leave you without a WR2. We solve
 * it exactly — the roster is small enough that there is no excuse not to.
 */

import { hungarian } from './hungarian.js';
import type { NewsAdjustment } from '../news/adjust.js';
import type { MarketAdjustment } from '../odds/market.js';
import { expandStartingSlots, isEligible, type LineupSlot, type Position, type RosterSettings } from '../types.js';
import type { MatchupAdjustment } from '../matchup/adjust.js';
import type { FormAdjustment } from '../form/adjust.js';

export interface OptimizerPlayer {
  readonly gsisId: string;
  readonly name: string;
  readonly position: Position;
  /** Platform-declared eligibility when known; falls back to position. */
  readonly eligibleSlots?: readonly LineupSlot[];
  readonly projectedPoints: number;
  /** False for a bye week, OUT, suspended, or IR. Such players cannot start. */
  readonly available: boolean;
  /** Shown in the UI so a benched player is never unexplained. */
  readonly unavailableReason?: string;
  /**
   * The slot this player is frozen into, if their game has already started.
   *
   * Platforms lock a player once their game kicks off, so any move involving
   * them will be rejected. Recommending one is worse than useless: it is advice
   * the user cannot act on. A locked player holds their slot and is excluded
   * from the matching entirely.
   */
  readonly lockedToSlot?: LineupSlot;
  /** Set when web news changed this player's projection; see news/adjust.ts. */
  readonly news?: NewsAdjustment;
  /** Set when betting lines were blended into the projection; see odds/market.ts. */
  readonly market?: MarketAdjustment;
  /** Set when the player's NFL matchup is known; see matchup/adjust.ts. */
  readonly matchup?: MatchupAdjustment;
  /** Set when the player has played this season; see form/adjust.ts. */
  readonly form?: FormAdjustment;
}

export interface SlotAssignment {
  readonly slot: LineupSlot;
  /** Distinguishes the two RB slots from each other. */
  readonly slotIndex: number;
  readonly player: OptimizerPlayer | null;
}

export interface LineupSolution {
  readonly starters: readonly SlotAssignment[];
  readonly bench: readonly OptimizerPlayer[];
  readonly projectedPoints: number;
}

/**
 * Weight used by the solver. Ineligible pairings score zero, which is also what
 * an empty slot scores — so the post-pass can turn either into an empty slot
 * without changing the optimum.
 *
 * This relies on every candidate having a non-negative projection; see
 * `optimizeLineup`, which filters negative projections out of the pool.
 */
function weight(player: OptimizerPlayer, slot: LineupSlot): number {
  return isEligible(player, slot) ? player.projectedPoints : 0;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Maximize projected points across the league's starting slots. */
export function optimizeLineup(
  players: readonly OptimizerPlayer[],
  settings: RosterSettings,
): LineupSolution {
  const allSlots = expandStartingSlots(settings);

  // Locked players are pinned to the slot they already hold; neither they nor
  // that slot take part in the optimization.
  const pinned = new Map<number, OptimizerPlayer>();
  const lockedIds = new Set<string>();
  const remainingSlotIndexes: number[] = [];

  const lockedQueue = new Map<LineupSlot, OptimizerPlayer[]>();
  for (const p of players) {
    if (!p.lockedToSlot) continue;
    const list = lockedQueue.get(p.lockedToSlot) ?? [];
    list.push(p);
    lockedQueue.set(p.lockedToSlot, list);
  }

  allSlots.forEach((slot, index) => {
    const queue = lockedQueue.get(slot);
    const holder = queue?.shift();
    if (holder) {
      pinned.set(index, holder);
      lockedIds.add(holder.gsisId);
    } else {
      remainingSlotIndexes.push(index);
    }
  });

  const slots = remainingSlotIndexes.map((i) => allSlots[i]!);

  // Unavailable players cannot fill a slot at all. A player projected below zero
  // is worse than an empty slot, which scores zero, so they are benched too —
  // and excluding them here keeps every solver weight non-negative.
  const candidates = players.filter(
    (p) => p.available && p.projectedPoints >= 0 && !lockedIds.has(p.gsisId),
  );

  if (allSlots.length === 0) {
    return { starters: [], bench: [...players], projectedPoints: 0 };
  }

  // The solver needs at least as many columns as rows; pad with dummy players
  // that are ineligible everywhere, which the post-pass turns into empty slots.
  const columns = Math.max(candidates.length, slots.length, 1);
  const cost: number[][] = slots.map((slot) => {
    const row = new Array<number>(columns).fill(0);
    for (let j = 0; j < candidates.length; j++) {
      row[j] = -weight(candidates[j]!, slot);
    }
    return row;
  });

  const rowToCol = slots.length > 0 ? hungarian(cost) : [];

  const startedIds = new Set<string>(lockedIds);
  const solved = new Map<number, OptimizerPlayer | null>();
  slots.forEach((slot, i) => {
    const col = rowToCol[i] ?? -1;
    const player = col >= 0 && col < candidates.length ? candidates[col] : undefined;
    // A padded column, or a forced ineligible pairing, means the slot stays empty.
    if (!player || !isEligible(player, slot)) {
      solved.set(remainingSlotIndexes[i]!, null);
      return;
    }
    startedIds.add(player.gsisId);
    solved.set(remainingSlotIndexes[i]!, player);
  });

  const starters: SlotAssignment[] = allSlots.map((slot, index) => ({
    slot,
    slotIndex: index,
    player: pinned.get(index) ?? solved.get(index) ?? null,
  }));

  const bench = players.filter((p) => !startedIds.has(p.gsisId));
  const projectedPoints = round2(
    starters.reduce((sum, s) => sum + (s.player?.projectedPoints ?? 0), 0),
  );

  return { starters, bench, projectedPoints };
}

export interface LineupMove {
  readonly player: OptimizerPlayer;
  readonly from: LineupSlot | 'BENCH';
  readonly to: LineupSlot | 'BENCH';
}

export interface LineupDiff {
  readonly moves: readonly LineupMove[];
  /**
   * How many starting slots end up with a different player.
   *
   * This is what a person means by "changes". `moves` counts each player
   * movement, so a single swap appears there twice — once for the player
   * coming in and once for the player going out — which reads as "2 changes"
   * for what is plainly one.
   */
  readonly slotsChanged: number;
  readonly pointsGained: number;
  /** True when the current lineup is already optimal — render it as such. */
  readonly alreadyOptimal: boolean;
}

/**
 * Compare a current lineup to the optimum.
 *
 * Returns moves rather than a lineup, because that is what a user has to act on,
 * and `alreadyOptimal` so a satisfied lineup renders as "nothing to do" instead
 * of a confusing empty move list.
 */
export function diffLineup(
  current: readonly SlotAssignment[],
  optimal: LineupSolution,
): LineupDiff {
  const slotOf = new Map<string, LineupSlot>();
  for (const a of current) if (a.player) slotOf.set(a.player.gsisId, a.slot);

  const moves: LineupMove[] = [];
  for (const a of optimal.starters) {
    if (!a.player) continue;
    const from = slotOf.get(a.player.gsisId) ?? 'BENCH';
    if (from !== a.slot) moves.push({ player: a.player, from, to: a.slot });
  }
  for (const p of optimal.bench) {
    const from = slotOf.get(p.gsisId);
    if (from) moves.push({ player: p, from, to: 'BENCH' });
  }

  // Count slots whose occupant actually differs, matched by slot index so the
  // two RB slots are compared against their counterparts rather than each other.
  const currentBySlotIndex = new Map(current.map((a) => [a.slotIndex, a.player?.gsisId ?? null]));
  let slotsChanged = 0;
  for (const a of optimal.starters) {
    const before = currentBySlotIndex.get(a.slotIndex) ?? null;
    if (before !== (a.player?.gsisId ?? null)) slotsChanged++;
  }

  const currentPoints = current.reduce((s, a) => s + (a.player?.projectedPoints ?? 0), 0);
  return {
    moves,
    slotsChanged,
    pointsGained: round2(optimal.projectedPoints - currentPoints),
    alreadyOptimal: moves.length === 0,
  };
}
