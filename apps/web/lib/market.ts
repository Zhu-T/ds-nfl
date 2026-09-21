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
  MARKET_STAT_IDS,
  MARKET_WEIGHT,
  calibrateMarket,
  fetchWeekOdds,
  kickoffWindow,
  marketAdjustment,
  type EspnReader,
  type LeagueRef,
  type MarketCalibration,
  type MarketSample,
  type PlayerLines,
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
  /** The week's typical line-to-ESPN ratio per stat and kickoff window, divided out before blending. */
  readonly calibration: MarketCalibration;
  /** When the context was built: which games are near kickoff is judged from here. */
  readonly now: number;
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
  reader: EspnReader,
  ref: LeagueRef,
): Promise<{ ctx: MarketContext | null; status: OddsStatus }> {
  const off = { enabled: false, available: false, provider: null, error: null };
  if (!(await oddsEnabled())) return { ctx: null, status: off };
  try {
    const odds = await fetchWeekOdds(league.season, week);
    const items = ((league.scoringRaw as { scoringItems?: EspnScoringItem[] } | null)?.scoringItems ?? []);
    const calibration = await calibrationFor(odds, reader, ref, week).catch(() => calibrateMarket([]));
    return {
      ctx: { odds, rules: parseEspnScoring(items), calibration, now: Date.now() },
      status: { enabled: true, available: odds.teams.size > 0, provider: odds.provider, error: null },
    };
  } catch (error) {
    return {
      ctx: null,
      status: { ...off, enabled: true, error: error instanceof Error ? error.message : String(error) },
    };
  }
}

/**
 * Calibrations by week and odds fetch: measured once per refresh of the lines
 * (every half hour), and the same for every page, whichever players it prices.
 */
const calibrations = new Map<string, Promise<MarketCalibration>>();

/** ESPN's projected stat line for every player with props, against their lines. */
function calibrationFor(odds: WeekOdds, reader: EspnReader, ref: LeagueRef, week: number): Promise<MarketCalibration> {
  const key = `${ref.leagueId}:${odds.season}:${week}:${odds.fetchedAt}`;
  const hit = calibrations.get(key);
  if (hit) return hit;
  if (calibrations.size > 20) calibrations.clear();
  const made = (async () => {
    const ids = [...odds.props.keys()];
    if (ids.length === 0) return calibrateMarket([]);
    const players = await reader.getPlayersByIds(ref, week, ids);
    const now = Date.now();
    const samples: MarketSample[] = players.flatMap((p) => {
      const lines = odds.props.get(p.platformPlayerId);
      const stats = p.projectedStats;
      if (!lines || !stats) return [];
      const window = kickoffWindow(p.proTeam ? odds.teams.get(p.proTeam)?.kickoff : null, now);
      return (Object.keys(MARKET_STAT_IDS) as (keyof PlayerLines)[]).flatMap((k) => {
        const line = lines[k];
        const espn = stats[MARKET_STAT_IDS[k]];
        return line !== undefined && espn !== undefined ? [{ key: k, line, espn, window }] : [];
      });
    });
    return calibrateMarket(samples);
  })();
  calibrations.set(key, made);
  made.catch(() => calibrations.delete(key));
  return made;
}

/** The market-blended projection for one player, lines calibrated for their kickoff window, or null to keep ESPN's. */
export function adjustFor(ctx: MarketContext | null, p: RosterPlayer): MarketAdjustment | null {
  if (!ctx) return null;
  const window = kickoffWindow(p.proTeam ? ctx.odds.teams.get(p.proTeam)?.kickoff : null, ctx.now);
  return marketAdjustment(p, ctx.odds.props.get(p.platformPlayerId), ctx.rules, MARKET_WEIGHT, (key) =>
    ctx.calibration.factor(key, window),
  );
}

/** A player's NFL game line for the week, if one is posted. */
export function gameFor(ctx: MarketContext | null, proTeam: string | null): TeamOdds | null {
  return ctx && proTeam ? (ctx.odds.teams.get(proTeam) ?? null) : null;
}
