/**
 * Scoping. Three layers, deliberately separate.
 *
 * Conflating these is the easiest way to produce confidently wrong numbers:
 * a player's projected *stat line* is a league-independent fact, but their
 * *points*, *VORP*, and *tier* are meaningless without a league, and whether
 * you should start, drop, or trade for them is meaningless without a team.
 */

import type { ScoringRuleSet } from './scoring/rules.js';
import type { RosterSettings } from './types.js';
import type { OptimizerPlayer } from './lineup/optimize.js';
import type { SeasonContext } from './data/seasons.js';

export type { SeasonContext };

/**
 * Everything that makes a league's numbers its own.
 *
 * Two leagues in the same week see the same stat lines and derive different
 * points, different replacement levels, and therefore a different board.
 */
export interface LeagueContext {
  readonly leagueId: string;
  readonly platform: string;
  /** NFL time — shared by every league. */
  readonly season: SeasonContext;
  readonly scoring: ScoringRuleSet;
  readonly roster: RosterSettings;
  readonly teamCount: number;
  /** Which ADP variant applies here; superflex ADP is a different board. */
  readonly adpFormat: 'standard' | 'half' | 'ppr' | 'superflex';
}

/**
 * A single team's viewpoint inside a league.
 *
 * Note this models *any* team, not only yours. The trade finder needs to
 * evaluate an offer from the counterparty's side to know whether they would
 * rationally accept it, and that requires their roster and their holes — the
 * same machinery, pointed at someone else.
 */
export interface TeamContext {
  readonly league: LeagueContext;
  readonly teamId: string;
  readonly isMine: boolean;
  readonly roster: readonly OptimizerPlayer[];
}

/**
 * Cache key for anything league-scoped.
 *
 * Player valuations must never be memoized on `playerId` alone. The same player
 * is a different asset in a 10-team standard league and a 12-team superflex
 * league, and a cache that forgets this is silently wrong in the second league
 * the user connects.
 */
export function valuationKey(ctx: LeagueContext, playerId: string, week?: number): string {
  return `${ctx.leagueId}:${week ?? 'season'}:${playerId}`;
}

/** Cache key for anything team-scoped: lineups, waiver targets, trade fits. */
export function recommendationKey(ctx: TeamContext, kind: string, week?: number): string {
  return `${ctx.league.leagueId}:${ctx.teamId}:${week ?? 'season'}:${kind}`;
}
