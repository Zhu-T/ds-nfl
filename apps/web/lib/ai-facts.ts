/**
 * Adapts page data into the fact briefs the language model is allowed to see.
 */

import 'server-only';
import { openedRoleNote, type OptimizerPlayer } from '@ds-nfl/core';
import type { LineupFactsInput, LineupMoveFact } from '@ds-nfl/llm';
import { matchupSentence } from './matchup-label';
import { formSentence } from './form-label';
import type { WeekView } from './week';

/** What a model should know about one player beyond the projection. */
function playerNote(p: OptimizerPlayer, view: WeekView): string {
  const opening = view.openings[p.gsisId];
  return [
    p.unavailableReason,
    p.matchup ? matchupSentence(p.matchup, p.position) : undefined,
    p.form ? formSentence(p.form) : undefined,
    opening ? openedRoleNote(opening, p.position) : undefined,
  ]
    .filter(Boolean)
    .join('; ');
}

/**
 * Pair each player coming into the lineup with the one they replace.
 *
 * A swap shows up in the diff as two moves — one in, one out — so the pairing
 * is by slot: the player leaving a slot is the one the incoming player takes it
 * from. Where nothing leaves that slot, the next unpaired outgoing player is
 * used, which covers players shuffling between flex and a dedicated slot.
 */
export function lineupFactsInput(view: WeekView): LineupFactsInput {
  const incoming = view.diff.moves.filter((m) => m.to !== 'BENCH');
  const outgoing = view.diff.moves.filter((m) => m.to === 'BENCH');
  const paired = new Set<string>();

  const moves: LineupMoveFact[] = incoming.map((m) => {
    const out =
      outgoing.find((o) => o.from === m.to && !paired.has(o.player.gsisId)) ??
      outgoing.find((o) => !paired.has(o.player.gsisId));
    if (out) paired.add(out.player.gsisId);
    return {
      slot: m.to,
      outName: out?.player.name ?? null,
      outProjected: out ? out.player.projectedPoints : null,
      ...(out?.player.unavailableReason ? { outNote: out.player.unavailableReason } : {}),
      inName: m.player.name,
      inPosition: m.player.position,
      inProjected: m.player.projectedPoints,
    };
  });

  const everyone = [
    ...view.optimal.starters.flatMap((s) => (s.player ? [s.player] : [])),
    ...view.optimal.bench,
  ];

  return {
    planningAhead: view.isFuture,
    marketBlended: everyone.filter((p) => p.market).length,
    newsAdjusted: everyone.flatMap((p) =>
      p.news ? [{ name: p.name, status: p.news.status, from: p.news.from, to: p.projectedPoints }] : [],
    ),
    leagueName: view.league.name,
    format: view.league.format,
    week: view.league.week,
    currentPoints: view.currentPoints,
    optimizedPoints: view.optimal.projectedPoints,
    pointsGained: view.diff.pointsGained,
    moves,
    lockedPlayers: everyone.filter((p) => p.lockedToSlot).map((p) => p.name),
    flagged: view.optimal.starters.flatMap((s) =>
      s.player && s.player.available && s.player.unavailableReason
        ? [{ name: s.player.name, note: s.player.unavailableReason }]
        : [],
    ),
    roster: [
      ...view.optimal.starters.flatMap((s) => (s.player ? [{ player: s.player, slot: String(s.slot) }] : [])),
      ...view.optimal.bench.map((p) => ({ player: p, slot: 'BENCH' })),
    ].map(({ player, slot }) => {
      const note = playerNote(player, view);
      return { name: player.name, position: player.position, slot, projected: player.projectedPoints, ...(note ? { note } : {}) };
    }),
    matchup: view.matchup
      ? {
          opponent: view.matchup.opponentName,
          opponentProjected: view.matchup.opponentProjected,
          opponentBest: view.matchup.opponentBasis === 'best',
          marginNow: view.matchup.marginNow,
          marginAfter: view.matchup.marginAfter,
        }
      : null,
  };
}
