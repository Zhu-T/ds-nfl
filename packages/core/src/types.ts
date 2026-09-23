/**
 * Shared domain vocabulary. Everything downstream — scoring, valuation,
 * optimization — is expressed in these terms, never in a platform's own ids.
 * Platform-specific numbers (ESPN's `defaultPositionId`, `lineupSlotId`,
 * `statId`) are translated at the adapter boundary and never leak in here.
 */

export const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'] as const;
export type Position = (typeof POSITIONS)[number];

/**
 * Roster slots. FLEX/OP are the reason lineup setting is an assignment problem
 * rather than a sort: a player is eligible for several slots at once.
 */
export const LINEUP_SLOTS = [
  'QB',
  'RB',
  'WR',
  'TE',
  'FLEX', // RB/WR/TE
  'RB_WR', // RB/WR
  'WR_TE', // WR/TE
  'OP', // superflex — QB/RB/WR/TE
  'K',
  'DST',
  'BENCH',
  'IR',
] as const;
export type LineupSlot = (typeof LINEUP_SLOTS)[number];

/** Which positions may legally fill each slot. */
export const SLOT_ELIGIBILITY: Readonly<Record<LineupSlot, readonly Position[]>> = {
  QB: ['QB'],
  RB: ['RB'],
  WR: ['WR'],
  TE: ['TE'],
  FLEX: ['RB', 'WR', 'TE'],
  RB_WR: ['RB', 'WR'],
  WR_TE: ['WR', 'TE'],
  OP: ['QB', 'RB', 'WR', 'TE'],
  K: ['K'],
  DST: ['DST'],
  BENCH: [...POSITIONS],
  IR: [...POSITIONS],
};

/** Slots that actually score points. BENCH and IR do not. */
export const STARTING_SLOTS: readonly LineupSlot[] = LINEUP_SLOTS.filter(
  (s) => s !== 'BENCH' && s !== 'IR',
);

/**
 * Default eligibility by position. This is a *fallback only*.
 *
 * Always prefer the platform's own per-player eligibility when it is available
 * (ESPN ships `eligibleSlots` on every player; Sleeper ships `fantasy_positions`).
 * Inferring eligibility from a position string is wrong for gadget players with
 * dual eligibility, for leagues that allow TE in a RB/WR flex, and for any
 * custom slot a league invents.
 */
export function defaultEligibility(position: Position, slot: LineupSlot): boolean {
  return SLOT_ELIGIBILITY[slot].includes(position);
}

/**
 * Resolve whether a player may fill a slot, preferring platform-declared
 * eligibility and falling back to the position table.
 */
export function isEligible(
  player: Pick<Player, 'position'> & { eligibleSlots?: readonly LineupSlot[] },
  slot: LineupSlot,
): boolean {
  return player.eligibleSlots
    ? player.eligibleSlots.includes(slot)
    : defaultEligibility(player.position, slot);
}

/**
 * How many of each starting slot a league uses, e.g. `{ QB: 1, RB: 2, WR: 2,
 * TE: 1, FLEX: 1, K: 1, DST: 1 }`. Kept structured end to end — the previous
 * implementation serialized this to `"1 QB, 2 RB, ..."` and re-parsed it with a
 * regex in two separate places.
 */
export type RosterSlotCounts = Partial<Record<LineupSlot, number>>;

export interface RosterSettings {
  readonly slots: RosterSlotCounts;
  readonly benchSize: number;
  readonly irSize: number;
}

/** Expand slot counts into one entry per physical starting slot. */
export function expandStartingSlots(settings: RosterSettings): LineupSlot[] {
  const out: LineupSlot[] = [];
  for (const slot of STARTING_SLOTS) {
    const n = settings.slots[slot] ?? 0;
    for (let i = 0; i < n; i++) out.push(slot);
  }
  return out;
}

export interface Player {
  /** nflverse `gsis_id` — our canonical key across every platform. */
  readonly gsisId: string;
  readonly name: string;
  readonly position: Position;
  readonly team: string | null;
  readonly espnId?: string;
  readonly sleeperId?: string;
  /**
   * Platform-declared slot eligibility, when known. Takes precedence over the
   * position-based fallback — see `isEligible`.
   */
  readonly eligibleSlots?: readonly LineupSlot[];
}

/**
 * How a player record was matched to an external source. Carried so callers can
 * weigh confidence: a name match across systems is materially less trustworthy
 * than an id match, and the previous implementation was right to surface it.
 */
export type MatchProvenance = 'id' | 'name' | 'none';

/** One week's pairing in a fantasy league's schedule. */
export interface SeasonMatchup {
  readonly week: number;
  readonly homeTeamId: string;
  readonly awayTeamId: string;
}
