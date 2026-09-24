/**
 * Value beyond this week: what a player adds to your best lineup across the
 * coming weeks, and which of your players you would miss least.
 *
 * The first week is priced as the rest of the app prices it (betting lines,
 * matchup, form, news). Later weeks use each player's rest-of-season projection
 * per game, and zero in a week their NFL team is on bye. So a running back who
 * covers your starter's bye, or simply out-projects your flex from here on,
 * shows value even when he would sit this week; and a second backup
 * quarterback, who never starts in a one-quarterback league, costs nothing to
 * drop.
 */

import { optimizeLineup, type OptimizerPlayer } from '../lineup/optimize.js';
import type { RosterSettings } from '../types.js';

export interface Outlook {
  /** Expected points per game for the rest of the season. */
  readonly perGame: number;
  /** Weeks, among those valued, in which the player's NFL team does not play. */
  readonly offWeeks: ReadonlySet<number>;
}

export interface Horizon {
  /** The weeks valued, the first being the week shown. */
  readonly weeks: readonly number[];
  /** By player id. A player without an outlook keeps their first-week projection every week. */
  readonly outlooks: ReadonlyMap<string, Outlook>;
}

export interface HorizonValue {
  /** Points across all the weeks, and per week in order. */
  readonly total: number;
  readonly byWeek: readonly number[];
}

export interface DropSuggestion extends HorizonValue {
  readonly playerId: string;
  readonly name: string;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Drop costs this close together, across the whole horizon, count as the same. */
export const DROP_TIE = 0.5;

/** A player in the horizon's week `index`: the first as priced; later ones at their rest-of-season rate, or out on a bye. */
function inWeek(p: OptimizerPlayer, horizon: Horizon, index: number): OptimizerPlayer {
  if (index === 0) return p;
  const outlook = horizon.outlooks.get(p.gsisId);
  if (!outlook) return p;
  const bye = outlook.offWeeks.has(horizon.weeks[index]!);
  // An injury is this week's; a rest-of-season projection already allows for time missed.
  return {
    gsisId: p.gsisId,
    name: p.name,
    position: p.position,
    ...(p.eligibleSlots ? { eligibleSlots: p.eligibleSlots } : {}),
    projectedPoints: bye ? 0 : outlook.perGame,
    available: !bye,
    ...(bye ? { unavailableReason: 'Bye' } : {}),
  };
}

function weeksOf(roster: readonly OptimizerPlayer[], horizon: Horizon, settings: RosterSettings) {
  return horizon.weeks.map((_, i) => {
    const players = roster.map((p) => inWeek(p, horizon, i));
    return { players, points: optimizeLineup(players, settings).projectedPoints };
  });
}

/** What each candidate adds to your best lineup in each week, and in total. Never negative. */
export function horizonValues(
  roster: readonly OptimizerPlayer[],
  candidates: readonly OptimizerPlayer[],
  horizon: Horizon,
  settings: RosterSettings,
): Map<string, HorizonValue> {
  const weeks = weeksOf(roster, horizon, settings);
  const out = new Map<string, HorizonValue>();
  for (const c of candidates) {
    const byWeek = weeks.map((w, i) =>
      round2(Math.max(0, optimizeLineup([...w.players, inWeek(c, horizon, i)], settings).projectedPoints - w.points)),
    );
    out.set(c.gsisId, { total: round2(byWeek.reduce((sum, x) => sum + x, 0)), byWeek });
  }
  return out;
}

/**
 * What losing each of `droppable` would cost your best lineups across the
 * weeks, cheapest first.
 *
 * Costs within `DROP_TIE` of each other count as the same, and those go first
 * to the position with the most spare players for each one it starts: two
 * spare quarterbacks behind one starter before two spare receivers behind
 * three, though all of them cost nothing. Spare receivers are injury cover for
 * several slots; spare quarterbacks cover one. Then the lower rest-of-season
 * projection, so of two spare quarterbacks the weaker one.
 */
export function dropCosts(
  roster: readonly OptimizerPlayer[],
  horizon: Horizon,
  settings: RosterSettings,
  droppable: ReadonlySet<string>,
): DropSuggestion[] {
  const weeks = weeksOf(roster, horizon, settings);
  const rate = (p: OptimizerPlayer) => horizon.outlooks.get(p.gsisId)?.perGame ?? p.projectedPoints;
  const starting = new Map<string, number>();
  for (const s of optimizeLineup(weeks[0]?.players ?? roster, settings).starters) {
    if (s.player) starting.set(s.player.position, (starting.get(s.player.position) ?? 0) + 1);
  }
  const held = new Map<string, number>();
  for (const p of roster) held.set(p.position, (held.get(p.position) ?? 0) + 1);
  const spare = (p: OptimizerPlayer) => {
    const starters = starting.get(p.position) ?? 0;
    return ((held.get(p.position) ?? 0) - starters) / Math.max(1, starters);
  };
  // Buckets rather than a tolerance in the comparison, so the ordering stays consistent.
  const bucket = (total: number) => Math.floor(total / DROP_TIE);
  return roster
    .filter((p) => droppable.has(p.gsisId))
    .map((p) => {
      const byWeek = weeks.map((w) =>
        round2(Math.max(0, w.points - optimizeLineup(w.players.filter((q) => q.gsisId !== p.gsisId), settings).projectedPoints)),
      );
      return { player: p, suggestion: { playerId: p.gsisId, name: p.name, total: round2(byWeek.reduce((s, x) => s + x, 0)), byWeek } };
    })
    .sort(
      (a, b) =>
        bucket(a.suggestion.total) - bucket(b.suggestion.total) ||
        spare(b.player) - spare(a.player) ||
        rate(a.player) - rate(b.player) ||
        a.suggestion.total - b.suggestion.total,
    )
    .map((x) => x.suggestion);
}

/**
 * What swapping one of your players for another does to your best lineup in
 * each week, and in total: the value of a one-for-one trade to you. Negative
 * when it hurts.
 */
export function swapValue(
  roster: readonly OptimizerPlayer[],
  outgoingId: string,
  incoming: OptimizerPlayer,
  horizon: Horizon,
  settings: RosterSettings,
): HorizonValue {
  const weeks = weeksOf(roster, horizon, settings);
  const byWeek = weeks.map((w, i) =>
    round2(
      optimizeLineup([...w.players.filter((p) => p.gsisId !== outgoingId), inWeek(incoming, horizon, i)], settings)
        .projectedPoints - w.points,
    ),
  );
  return { total: round2(byWeek.reduce((sum, x) => sum + x, 0)), byWeek };
}

/**
 * What a whole trade does to your best lineups: several players out, several
 * in, priced week by week like `swapValue`. Negative when the trade hurts.
 *
 * A real offer is rarely one-for-one, and the sides can be uneven — two for one
 * leaves a roster spot open, which costs nothing here because an empty spot
 * starts nobody either way.
 */
export function tradeValue(
  roster: readonly OptimizerPlayer[],
  outgoingIds: readonly string[],
  incoming: readonly OptimizerPlayer[],
  horizon: Horizon,
  settings: RosterSettings,
): HorizonValue {
  const leaving = new Set(outgoingIds);
  const weeks = weeksOf(roster, horizon, settings);
  const byWeek = weeks.map((w, i) =>
    round2(
      optimizeLineup(
        [...w.players.filter((p) => !leaving.has(p.gsisId)), ...incoming.map((p) => inWeek(p, horizon, i))],
        settings,
      ).projectedPoints - w.points,
    ),
  );
  return { total: round2(byWeek.reduce((sum, x) => sum + x, 0)), byWeek };
}
