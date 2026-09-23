/**
 * Waiver and free-agent value.
 *
 * The number that matters is not a player's projection — it is how much they
 * would raise *your starting lineup*. A 12-point WR is worth nothing to a team
 * whose worst starting receiver already projects 14, and a modest tight end can
 * be worth a lot to a team starting nobody there.
 *
 * So every candidate is priced by re-running the optimizer with them on the
 * roster and taking the difference. That is the same machinery the lineup page
 * uses, which means the two can never disagree.
 */

import { optimizeLineup, type OptimizerPlayer } from '../lineup/optimize.js';
import type { LineupSlot, RosterSettings } from '../types.js';

export interface WaiverCandidate {
  readonly player: OptimizerPlayer;
  /** Points added to the optimal starting lineup by rostering this player. */
  readonly lineupGain: number;
  /** Who they would displace, if anyone. */
  readonly displaces: string | null;
  /** Weakest roster player who is not in the optimal lineup once this one is in. */
  readonly dropCandidate: string | null;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Rank free agents by what they would actually add.
 *
 * Candidates who improve nothing are returned with `lineupGain: 0` rather than
 * dropped, so the caller can show "nobody available helps" — which is a real and
 * useful answer, not an empty list.
 *
 * `protectedIds` are players the user has marked as never to be dropped; they
 * are skipped when naming who would make room.
 */
export function rankWaiverCandidates(
  roster: readonly OptimizerPlayer[],
  candidates: readonly OptimizerPlayer[],
  settings: RosterSettings,
  protectedIds: ReadonlySet<string> = new Set(),
): WaiverCandidate[] {
  const base = optimizeLineup(roster, settings);
  const baseStarters = new Set(
    base.starters.filter((s) => s.player).map((s) => s.player!.gsisId),
  );

  const ranked = candidates.map<WaiverCandidate>((candidate) => {
    const withThem = optimizeLineup([...roster, candidate], settings);
    const gain = round2(withThem.projectedPoints - base.projectedPoints);

    // Who they pushed out of the lineup, if anyone.
    const nowStarting = new Set(
      withThem.starters.filter((s) => s.player).map((s) => s.player!.gsisId),
    );
    const displacedId = [...baseStarters].find((id) => !nowStarting.has(id)) ?? null;
    const displaces = displacedId
      ? (roster.find((p) => p.gsisId === displacedId)?.name ?? null)
      : null;

    // The cheapest player to cut to make room: lowest projection among those the
    // optimizer would not start anyway.
    const benched = roster
      .filter((p) => !nowStarting.has(p.gsisId) && !protectedIds.has(p.gsisId))
      .sort((a, b) => a.projectedPoints - b.projectedPoints);

    return {
      player: candidate,
      lineupGain: gain,
      displaces,
      dropCandidate: benched[0]?.name ?? null,
    };
  });

  return ranked.sort(
    (a, b) => b.lineupGain - a.lineupGain || b.player.projectedPoints - a.player.projectedPoints,
  );
}

/** What one player is worth to your starting lineup. */
export interface PlayerValue {
  /** Whether the player is already on your roster. */
  readonly onRoster: boolean;
  /** Your best lineup's projected total with the player, and without them. */
  readonly withPlayer: number;
  readonly withoutPlayer: number;
  /** withPlayer minus withoutPlayer: what adding them gains, or what losing them costs. */
  readonly value: number;
  /** The slot they fill in the best lineup; null when they would sit. */
  readonly slot: LineupSlot | null;
  /** For a player you would add: who they start over. */
  readonly displaces: string | null;
  /** For a player you would add: the weakest player who would not start, to drop. */
  readonly dropCandidate: string | null;
  /** For your own player: who would start in their place without them. */
  readonly replacedBy: string | null;
}

/**
 * One player's value to a roster: the best lineup with them minus the best
 * lineup without them. For a player you do not have, that is what adding them
 * gains, the same number `rankWaiverCandidates` ranks by; for one of yours, it
 * is what losing them costs.
 */
export function valueToRoster(
  roster: readonly OptimizerPlayer[],
  player: OptimizerPlayer,
  settings: RosterSettings,
  protectedIds: ReadonlySet<string> = new Set(),
): PlayerValue {
  const onRoster = roster.some((p) => p.gsisId === player.gsisId);
  const others = roster.filter((p) => p.gsisId !== player.gsisId);
  const without = optimizeLineup(others, settings);
  const withThem = optimizeLineup([...others, player], settings);
  const startersOf = (lineup: typeof without) =>
    new Set(lineup.starters.flatMap((s) => (s.player ? [s.player.gsisId] : [])));
  const before = startersOf(without);
  const after = startersOf(withThem);
  const nameOf = (id: string | undefined) => (id ? (others.find((p) => p.gsisId === id)?.name ?? null) : null);
  // The one starter who loses their place when the player is in the lineup.
  const pushedOut = [...before].find((id) => !after.has(id));

  return {
    onRoster,
    withPlayer: round2(withThem.projectedPoints),
    withoutPlayer: round2(without.projectedPoints),
    value: round2(withThem.projectedPoints - without.projectedPoints),
    slot: withThem.starters.find((s) => s.player?.gsisId === player.gsisId)?.slot ?? null,
    displaces: onRoster ? null : nameOf(pushedOut),
    dropCandidate: onRoster
      ? null
      : ([...others]
          .filter((p) => !after.has(p.gsisId) && !protectedIds.has(p.gsisId))
          .sort((a, b) => a.projectedPoints - b.projectedPoints)[0]?.name ?? null),
    replacedBy: onRoster ? nameOf(pushedOut) : null,
  };
}
