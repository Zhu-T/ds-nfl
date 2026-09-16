/**
 * Sample league used to exercise the UI until the platform adapters land.
 *
 * This is real engine output, not mocked-up screenshot data: the lineup below
 * is fed through the actual optimizer in @ds-nfl/core. Only the roster itself
 * is invented.
 *
 * Every screen that renders this MUST show the sample-data notice. The previous
 * build silently substituted a fabricated roster whenever ESPN auth failed, and
 * those fakes flowed into recommendations the user then acted on. Sample data is
 * never allowed to look like live data.
 */

import {
  optimizeLineup,
  diffLineup,
  type LineupSlot,
  type OptimizerPlayer,
  type RosterSettings,
  type SlotAssignment,
} from '@ds-nfl/core';

export const SAMPLE_ROSTER_SETTINGS: RosterSettings = {
  slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
  benchSize: 6,
  irSize: 1,
};

function p(
  gsisId: string,
  name: string,
  position: OptimizerPlayer['position'],
  projectedPoints: number,
  extra: Partial<OptimizerPlayer> = {},
): OptimizerPlayer {
  return { gsisId, name, position, projectedPoints, available: true, ...extra };
}

export const SAMPLE_PLAYERS: OptimizerPlayer[] = [
  p('allen', 'Josh Allen', 'QB', 23.8),
  p('daniels', 'Jayden Daniels', 'QB', 21.4),
  p('bijan', 'Bijan Robinson', 'RB', 18.6),
  p('gibbs', 'Jahmyr Gibbs', 'RB', 17.2),
  p('tracy', 'Tyrone Tracy Jr.', 'RB', 9.1),
  p('chase', "Ja'Marr Chase", 'WR', 20.3),
  p('nabers', 'Malik Nabers', 'WR', 16.8),
  p('odunze', 'Rome Odunze', 'WR', 11.4),
  // Projected at zero because he will not play — the optimizer must bench him.
  p('nacua', 'Puka Nacua', 'WR', 0, { available: false, unavailableReason: 'Out — knee' }),
  p('bowers', 'Brock Bowers', 'TE', 14.2),
  p('butker', 'Harrison Butker', 'K', 8.4),
  p('ravens', 'Ravens D/ST', 'DST', 7.9),
];

const byId = new Map(SAMPLE_PLAYERS.map((x) => [x.gsisId, x]));
const at = (id: string): OptimizerPlayer => {
  const found = byId.get(id);
  if (!found) throw new Error(`sample-league: unknown player "${id}"`);
  return found;
};

/**
 * The lineup as currently set on the platform — deliberately imperfect, in the
 * two ways real lineups usually are: an injured starter nobody swapped out, and
 * a better player sitting on the bench.
 */
export const SAMPLE_CURRENT_LINEUP: SlotAssignment[] = [
  { slot: 'QB', slotIndex: 0, player: at('allen') },
  { slot: 'RB', slotIndex: 1, player: at('bijan') },
  { slot: 'RB', slotIndex: 2, player: at('tracy') },
  { slot: 'WR', slotIndex: 3, player: at('chase') },
  { slot: 'WR', slotIndex: 4, player: at('nacua') },
  { slot: 'TE', slotIndex: 5, player: at('bowers') },
  { slot: 'FLEX', slotIndex: 6, player: at('odunze') },
  { slot: 'K', slotIndex: 7, player: at('butker') },
  { slot: 'DST', slotIndex: 8, player: at('ravens') },
];

export function buildSampleWeek() {
  const optimal = optimizeLineup(SAMPLE_PLAYERS, SAMPLE_ROSTER_SETTINGS);
  const diff = diffLineup(SAMPLE_CURRENT_LINEUP, optimal);
  const currentPoints = SAMPLE_CURRENT_LINEUP.reduce(
    (s, a) => s + (a.player?.projectedPoints ?? 0),
    0,
  );

  const current = Math.round(currentPoints * 10) / 10;
  const opponentProjected = 131.2;

  return {
    league: {
      name: "2026 Tommy's League",
      format: '12-team · Full PPR',
      season: 2026,
      week: 1,
      record: '0-0',
    },
    /**
     * The matchup, stated honestly: `current` is what the lineup as it stands
     * would score, which is the number that matters until the moves are applied.
     * Showing the optimized total here would imply a lineup that is not set.
     */
    matchup: {
      you: 'Tommy',
      opponent: 'Seahawks Fan Club',
      current,
      optimized: optimal.projectedPoints,
      opponentProjected,
      marginNow: Math.round((current - opponentProjected) * 10) / 10,
      marginAfter: Math.round((optimal.projectedPoints - opponentProjected) * 10) / 10,
    },
    optimal,
    diff,
    currentPoints: current,
    currentLineup: SAMPLE_CURRENT_LINEUP,
    currentBySlotIndex: new Map(SAMPLE_CURRENT_LINEUP.map((a) => [a.slotIndex, a.player])),
  };
}

/** Position hue token for a slot, matching depth-chart convention. */
export function slotHue(slot: LineupSlot): string {
  switch (slot) {
    case 'QB':
      return 'var(--pos-qb)';
    case 'RB':
      return 'var(--pos-rb)';
    case 'WR':
      return 'var(--pos-wr)';
    case 'TE':
      return 'var(--pos-te)';
    case 'K':
      return 'var(--pos-k)';
    case 'DST':
      return 'var(--pos-dst)';
    default:
      return 'var(--pos-flex)';
  }
}

export function positionHue(position: OptimizerPlayer['position']): string {
  return slotHue(position as LineupSlot);
}

export const SLOT_LABEL: Partial<Record<LineupSlot, string>> = {
  FLEX: 'FLX',
  RB_WR: 'R/W',
  WR_TE: 'W/T',
  DST: 'D/ST',
};
