/**
 * Betting odds in player evaluation: the week's lines, whether they are on, and
 * how a roster player's projection changes.
 *
 * Odds refine projections; the app works without them. Loading never throws,
 * and when the lines cannot be read every projection is ESPN's alone, with the
 * reason shown on the page.
 */

import 'server-only';
import { cookies } from 'next/headers';
import {
  fetchWeekOdds,
  marketAdjustment,
  parseEspnScoring,
  type EspnScoringItem,
  type EspnScoringRules,
  type LeagueInfo,
  type RosterPlayer,
  type TeamOdds,
  type WeekOdds,
} from '@ds-nfl/adapters';
import type { MarketAdjustment } from '@ds-nfl/core';
import { ODDS_COOKIE } from './pref-cookies';

export interface MarketContext {
  readonly odds: WeekOdds;
  readonly rules: EspnScoringRules;
}

/** Safe to send to the browser. */
export interface OddsStatus {
  readonly enabled: boolean;
  /** True when the week has game lines. */
  readonly available: boolean;
  readonly provider: string | null;
  readonly error: string | null;
}

export async function oddsEnabled(): Promise<boolean> {
  return (await cookies()).get(ODDS_COOKIE)?.value !== 'off';
}

export async function marketFor(
  league: LeagueInfo,
  week: number,
): Promise<{ ctx: MarketContext | null; status: OddsStatus }> {
  const off = { enabled: false, available: false, provider: null, error: null };
  if (!(await oddsEnabled())) return { ctx: null, status: off };
  try {
    const odds = await fetchWeekOdds(league.season, week);
    const items = ((league.scoringRaw as { scoringItems?: EspnScoringItem[] } | null)?.scoringItems ?? []);
    return {
      ctx: { odds, rules: parseEspnScoring(items) },
      status: { enabled: true, available: odds.teams.size > 0, provider: odds.provider, error: null },
    };
  } catch (error) {
    return {
      ctx: null,
      status: { ...off, enabled: true, error: error instanceof Error ? error.message : String(error) },
    };
  }
}

/** The market-blended projection for one player, or null to keep ESPN's. */
export function adjustFor(ctx: MarketContext | null, p: RosterPlayer): MarketAdjustment | null {
  return ctx ? marketAdjustment(p, ctx.odds.props.get(p.platformPlayerId), ctx.rules) : null;
}

/** A player's NFL game line for the week, if one is posted. */
export function gameFor(ctx: MarketContext | null, proTeam: string | null): TeamOdds | null {
  return ctx && proTeam ? (ctx.odds.teams.get(proTeam) ?? null) : null;
}
