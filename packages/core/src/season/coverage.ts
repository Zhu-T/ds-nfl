/**
 * Whether a roster can fill its starting slots in the coming weeks.
 *
 * A bye or an injury is obvious for one player; what matters is the week where
 * two running backs are off at once and the lineup cannot be filled. The exact
 * optimizer answers it: with only the players who can play that week, any slot
 * it leaves empty is a hole.
 */

import { optimizeLineup, type OptimizerPlayer } from '../lineup/optimize.js';
import type { LineupSlot, RosterSettings } from '../types.js';

export interface CoveragePlayer {
  readonly gsisId: string;
  readonly name: string;
  readonly position: OptimizerPlayer['position'];
  readonly eligibleSlots?: readonly LineupSlot[];
  /** Points per game from here on. */
  readonly perGame: number;
  /** False for players who cannot play at all: out for the season, or on IR. */
  readonly available: boolean;
  readonly unavailableReason?: string;
  /** Weeks this player's NFL team is on bye. */
  readonly offWeeks: ReadonlySet<number>;
}

export interface WeekCoverage {
  readonly week: number;
  /** Starting slots the roster cannot fill that week, in lineup order. */
  readonly short: readonly LineupSlot[];
  /** Players who cannot play that week, with why. */
  readonly missing: readonly { readonly name: string; readonly reason: string }[];
  /** The best lineup the roster could field that week, in points per game. */
  readonly projected: number;
}

/** Each week's holes, from the players who can actually play in it. */
export function coverageByWeek(
  players: readonly CoveragePlayer[],
  weeks: readonly number[],
  settings: RosterSettings,
): WeekCoverage[] {
  return weeks.map((week) => {
    const playable = players.map((p) => ({
      gsisId: p.gsisId,
      name: p.name,
      position: p.position,
      ...(p.eligibleSlots ? { eligibleSlots: p.eligibleSlots } : {}),
      projectedPoints: p.perGame,
      available: p.available && !p.offWeeks.has(week),
    }));
    const lineup = optimizeLineup(playable, settings);
    return {
      week,
      short: lineup.starters.filter((s) => !s.player).map((s) => s.slot),
      missing: players.flatMap((p) =>
        p.offWeeks.has(week)
          ? [{ name: p.name, reason: 'bye' }]
          : !p.available
            ? [{ name: p.name, reason: p.unavailableReason ?? 'out' }]
            : [],
      ),
      projected: Math.round(lineup.projectedPoints * 10) / 10,
    };
  });
}
