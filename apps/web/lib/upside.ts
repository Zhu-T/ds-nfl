/**
 * Playing for the win rather than for points: your chance of beating this
 * week's opponent, the lineup that maximises it, and the pickups that raise it
 * most. See packages/core/src/ceiling for the model.
 *
 * Never the primary logic. The Lineup page shows the upside lineup only when
 * its switch is on (off by default), beside the best-projected lineup, with its
 * own Apply; Waivers shows it as one ranking among several.
 */

import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import {
  applyForm,
  applyMatchups,
  bestWinLineup,
  lineupDistribution,
  optimizeLineup,
  outlookOf,
  rankForWinChance,
  spreadFor,
  winChance,
  type Distribution,
  type GameState,
  type OptimizerPlayer,
  type WeekOutlook,
  type WinLineup,
} from '@ds-nfl/core';
import { fetchGameStatus, type RosterPlayer } from '@ds-nfl/adapters';
import { UPSIDE_COOKIE } from './pref-cookies';
import { adjustFor } from './market';
import { matchupInputs } from './matchups';
import { formInputs } from './form';
import type { LineupPlan } from './week';

/** Off unless switched on: the upside lineup must never become the main recommendation. */
export async function upsideEnabled(): Promise<boolean> {
  return (await cookies()).get(UPSIDE_COOKIE)?.value === 'on';
}

/** Another team's players priced like yours: betting lines, the D/ST opponent model, and form; not your news findings. */
export function priceOpponent(plan: LineupPlan, players: readonly RosterPlayer[]): OptimizerPlayer[] {
  return applyForm(
    applyMatchups(
      players.map((p) => {
        const m = adjustFor(plan.market, p);
        return {
          gsisId: p.platformPlayerId,
          name: p.name,
          position: p.position,
          eligibleSlots: p.eligibleSlots,
          projectedPoints: m?.blended ?? p.projectedPoints,
          available: p.available,
          ...(m ? { market: m } : {}),
        };
      }),
      matchupInputs(plan.matchups, players),
    ),
    formInputs(players, plan.formOn),
  );
}

/** What the win chance is computed against. */
export interface WinSetup {
  readonly opponentName: string;
  /** "set": the lineup they have set for a week in play; "best": the best lineup their roster can field, for a week not started. */
  readonly opponentBasis: 'set' | 'best';
  readonly opponent: Distribution;
  /** Where each NFL team's game stands. */
  readonly stateOf: (proTeam: string | null) => GameState;
  /** A player's week as a distribution, from their roster record (for this week's actual points). */
  readonly outlookFrom: (records: readonly RosterPlayer[]) => (p: OptimizerPlayer) => WeekOutlook;
}

/** Null when there is no matchup this week (bye, offseason) or it cannot be read. Shared within a request. */
export const winSetupFor = cache(async (plan: LineupPlan): Promise<WinSetup | null> => {
  const raw = plan.rawMatchup;
  if (!raw) return null;
  try {
    const [theirs, status] = await Promise.all([
      plan.reader.getRoster({ ...plan.ref, teamId: raw.opponentTeamId }, plan.week),
      plan.isFuture ? Promise.resolve(null) : fetchGameStatus(plan.league.season, plan.week).catch(() => null),
    ]);
    const lockedTeams = new Set(plan.roster.filter((p) => p.locked).map((p) => p.proTeam));
    const stateOf = (team: string | null): GameState => {
      if (plan.isFuture || !team) return 'upcoming';
      // Without the scoreboard, a locked player's game has at least started.
      return status?.get(team) ?? (lockedTeams.has(team) ? 'live' : 'upcoming');
    };
    const outlookFrom = (records: readonly RosterPlayer[]) => {
      const byId = new Map(records.map((r) => [r.platformPlayerId, r]));
      return (p: OptimizerPlayer): WeekOutlook => {
        const r = byId.get(p.gsisId);
        return outlookOf(p, stateOf(r?.proTeam ?? null), r?.actualPoints);
      };
    };

    const priced = priceOpponent(plan, theirs.players);
    const starters = plan.isFuture
      ? optimizeLineup(priced, plan.league.rosterSettings).starters.flatMap((s) => (s.player ? [s.player] : []))
      : priced.filter((p) => {
          const slot = theirs.players.find((r) => r.platformPlayerId === p.gsisId)?.currentSlot;
          return slot !== undefined && slot !== 'BENCH' && slot !== 'IR';
        });
    return {
      opponentName: raw.opponentTeamName,
      opponentBasis: plan.isFuture ? 'best' : 'set',
      opponent: lineupDistribution(starters, outlookFrom(theirs.players)),
      stateOf,
      outlookFrom,
    };
  } catch {
    return null;
  }
});

const startersOf = (w: WinLineup) => w.solution.starters.flatMap((s) => (s.player ? [s.player] : []));
const pct = (x: number) => Math.round(x * 1000) / 10;
const round1 = (n: number) => Math.round(n * 10) / 10;

export interface UpsideMove {
  readonly name: string;
  readonly position: string;
  readonly projected: number;
  readonly ceiling: number;
}

/** Safe to send to the browser. Chances are percentages, e.g. 12.5. */
export interface UpsideView {
  readonly opponentName: string;
  readonly opponentBasis: 'set' | 'best';
  /** Your best-projected lineup's mean minus theirs; negative when behind. */
  readonly margin: number;
  readonly bestChance: number;
  readonly upsideChance: number;
  /** True when the upside lineup starts different players and raises the chance meaningfully. */
  readonly worthIt: boolean;
  readonly startIn: readonly UpsideMove[];
  readonly sitOut: readonly UpsideMove[];
}

/** A different lineup is suggested only when it adds at least this many points of win chance. */
export const UPSIDE_MIN_GAIN = 2;

/** The upside lineup beside the best-projected one; null without a matchup. */
export async function upsideView(plan: LineupPlan): Promise<UpsideView | null> {
  const setup = await winSetupFor(plan);
  if (!setup) return null;
  const outlook = setup.outlookFrom(plan.roster);
  const bestStarters = plan.optimal.starters.flatMap((s) => (s.player ? [s.player] : []));
  const best = lineupDistribution(bestStarters, outlook);
  const upside = bestWinLineup(plan.players, plan.league.rosterSettings, outlook, setup.opponent);
  const bestChance = winChance(best, setup.opponent);
  const bestIds = new Set(bestStarters.map((p) => p.gsisId));
  const upIds = new Set(startersOf(upside).map((p) => p.gsisId));
  const move = (p: OptimizerPlayer): UpsideMove => ({
    name: p.name,
    position: p.position,
    projected: p.projectedPoints,
    ceiling: spreadFor(p.position, p.projectedPoints).ceiling,
  });
  const startIn = startersOf(upside).filter((p) => !bestIds.has(p.gsisId)).map(move);
  const sitOut = bestStarters.filter((p) => !upIds.has(p.gsisId)).map(move);
  return {
    opponentName: setup.opponentName,
    opponentBasis: setup.opponentBasis,
    margin: round1(best.mean - setup.opponent.mean),
    bestChance: pct(bestChance),
    upsideChance: pct(upside.chance),
    worthIt: startIn.length > 0 && pct(upside.chance) - pct(bestChance) >= UPSIDE_MIN_GAIN,
    startIn,
    sitOut,
  };
}

/** The upside lineup itself, for applying: recomputed on the server, never taken from the page. */
export async function upsideLineup(plan: LineupPlan): Promise<WinLineup | null> {
  const setup = await winSetupFor(plan);
  if (!setup) return null;
  return bestWinLineup(plan.players, plan.league.rosterSettings, setup.outlookFrom(plan.roster), setup.opponent);
}

export interface CeilingRow {
  readonly id: string;
  readonly name: string;
  readonly position: string;
  readonly projected: number;
  readonly ceiling: number;
  /** Win chance, in percent, without and with them. */
  readonly before: number;
  readonly after: number;
  readonly displaces: string | null;
}

export interface CeilingView {
  readonly opponentName: string;
  readonly opponentBasis: 'set' | 'best';
  readonly margin: number;
  /** Your best win chance with the roster as it is, in percent. */
  readonly chance: number;
  /** Pickups that raise it, most first. */
  readonly rows: readonly CeilingRow[];
  /** Available players whose game has not started, and so could still play for you. */
  readonly considered: number;
}

/** Pickups weighed at most; the highest ceilings first. */
const CEILING_CANDIDATES = 80;

/** Pickups ranked by how much each raises your chance of winning this week; null without a matchup. */
export async function ceilingView(plan: LineupPlan, pool: readonly OptimizerPlayer[], poolRecords: readonly RosterPlayer[]): Promise<CeilingView | null> {
  const setup = await winSetupFor(plan);
  if (!setup) return null;
  const records = new Map(poolRecords.map((r) => [r.platformPlayerId, r]));
  const candidates = pool
    .filter((p) => p.available && p.projectedPoints > 0 && setup.stateOf(records.get(p.gsisId)?.proTeam ?? null) === 'upcoming')
    .sort((a, b) => spreadFor(b.position, b.projectedPoints).ceiling - spreadFor(a.position, a.projectedPoints).ceiling)
    .slice(0, CEILING_CANDIDATES);
  const outlook = setup.outlookFrom([...plan.roster, ...poolRecords]);
  const { base, ranked } = rankForWinChance(plan.players, candidates, plan.league.rosterSettings, outlook, setup.opponent);
  const bestStarters = plan.optimal.starters.flatMap((s) => (s.player ? [s.player] : []));
  return {
    opponentName: setup.opponentName,
    opponentBasis: setup.opponentBasis,
    margin: round1(lineupDistribution(bestStarters, outlook).mean - setup.opponent.mean),
    chance: pct(base.chance),
    considered: candidates.length,
    rows: ranked
      .filter((c) => pct(c.after) > pct(c.before))
      .map((c) => ({
        id: c.player.gsisId,
        name: c.player.name,
        position: c.player.position,
        projected: c.player.projectedPoints,
        ceiling: c.ceiling,
        before: pct(c.before),
        after: pct(c.after),
        displaces: c.displaces,
      })),
  };
}
