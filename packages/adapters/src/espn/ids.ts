/**
 * ESPN's numeric id spaces.
 *
 * ESPN uses two different position numberings and they collide on two values.
 * `defaultPositionId` says what a *player* is; `lineupSlotId` says what *slot*
 * they occupy. RB is 2 in both, and D/ST is 16 in both, which is precisely why
 * mixing them produces wrong-but-plausible results rather than an obvious error.
 *
 * See docs/espn-protocol.md.
 */

import type { LineupSlot, Position } from '@ds-nfl/core';

/** `defaultPositionId` — what position a player is. */
export const PLAYER_POSITION_BY_ID: Readonly<Record<number, Position>> = {
  1: 'QB',
  2: 'RB',
  3: 'WR',
  4: 'TE',
  5: 'K',
  16: 'DST',
};

/**
 * `lineupSlotId` — what roster slot a player occupies.
 * Slots 3 and 23 are both RB/WR/TE flex; leagues use one or the other.
 */
export const LINEUP_SLOT_BY_ID: Readonly<Record<number, LineupSlot>> = {
  0: 'QB',
  2: 'RB',
  3: 'FLEX',
  4: 'WR',
  6: 'TE',
  7: 'OP',
  16: 'DST',
  17: 'K',
  20: 'BENCH',
  21: 'IR',
  23: 'FLEX',
  24: 'RB_WR',
  25: 'WR_TE',
};

/** Slot ids that hold players but never score. */
export const NON_SCORING_SLOT_IDS = new Set([20, 21]);

export function positionFromId(id: number | undefined): Position | null {
  return id === undefined ? null : (PLAYER_POSITION_BY_ID[id] ?? null);
}

export function slotFromId(id: number | undefined): LineupSlot | null {
  return id === undefined ? null : (LINEUP_SLOT_BY_ID[id] ?? null);
}

/**
 * Injury statuses that stop a player from being startable.
 *
 * QUESTIONABLE and DOUBTFUL are deliberately absent: those players can still
 * play, and benching them automatically would silently cost points. They carry
 * a flag in the UI instead so the decision stays with the manager.
 */
const CANNOT_PLAY = new Set([
  'OUT',
  'INJURY_RESERVE',
  'SUSPENSION',
  'NOT_ACTIVE',
  'DOUBTFUL_FOR_SEASON',
]);

export interface Availability {
  available: boolean;
  reason?: string;
}

export function availabilityFromInjury(status: string | undefined): Availability {
  if (!status || status === 'ACTIVE' || status === 'NORMAL') return { available: true };
  if (CANNOT_PLAY.has(status)) {
    return { available: false, reason: humanInjury(status) };
  }
  // Playable but worth flagging (QUESTIONABLE, DOUBTFUL, ...).
  return { available: true, reason: humanInjury(status) };
}

function humanInjury(status: string): string {
  switch (status) {
    case 'OUT':
      return 'Out';
    case 'INJURY_RESERVE':
      return 'Injured reserve';
    case 'SUSPENSION':
      return 'Suspended';
    case 'QUESTIONABLE':
      return 'Questionable';
    case 'DOUBTFUL':
      return 'Doubtful';
    case 'NOT_ACTIVE':
      return 'Not active';
    default:
      return status.toLowerCase().replace(/_/g, ' ');
  }
}

/** ESPN `proTeamId` to abbreviation. 0 is free agent. */
export const PRO_TEAM_BY_ID: Readonly<Record<number, string>> = {
  0: 'FA', 1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN',
  8: 'DET', 9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA',
  16: 'MIN', 17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT',
  24: 'LAC', 25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WSH', 29: 'CAR', 30: 'JAX',
  33: 'BAL', 34: 'HOU',
};

/** Build a typed RosterSettings from ESPN's `lineupSlotCounts` map. */
export function rosterSettingsFromSlotCounts(counts: Record<string, number>): {
  slots: Partial<Record<LineupSlot, number>>;
  benchSize: number;
  irSize: number;
} {
  const slots: Partial<Record<LineupSlot, number>> = {};
  let benchSize = 0;
  let irSize = 0;

  for (const [idStr, count] of Object.entries(counts)) {
    if (!count) continue;
    const id = Number(idStr);
    if (id === 20) {
      benchSize = count;
      continue;
    }
    if (id === 21) {
      irSize = count;
      continue;
    }
    const slot = slotFromId(id);
    if (!slot) continue; // unknown slot id: ignored rather than guessed at
    slots[slot] = (slots[slot] ?? 0) + count;
  }

  return { slots, benchSize, irSize };
}
