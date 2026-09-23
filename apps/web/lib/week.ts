/**
 * Loads a week, from the connected league when there is one and from the
 * sample roster otherwise.
 *
 * The week is the one being played or, while it is, the next one: the week
 * switch in the scorebug picks which, and actions name the week they were
 * rendered for. The live and sample paths return the same shape but are never
 * confused: `isSample` drives a visible notice. Sample data must never be
 * mistakable for live data.
 */

import 'server-only';
import { cache } from 'react';
import {
  applyForm,
  applyMatchups,
  applyNewsFindings,
  diffLineup,
  optimizeLineup,
  type OpenedRole,
  type LineupDiff,
  type LineupSolution,
  type OptimizerPlayer,
  type RosterSettings,
  type SlotAssignment,
} from '@ds-nfl/core';
import {
  AdapterFailure,
  EspnReader,
  activeFindings,
  describeError,
  leagueKey,
  readNewsReport,
  rememberLeagueNames,
  resolveLeague,
  type LeagueConnection,
  type LeagueInfo,
  type LeagueRef,
  type Matchup,
  type NewsReport,
  type RosterPlayer,
} from '@ds-nfl/adapters';
import { buildSampleWeek } from './sample-league';
import { resolveWeek } from './week-choice';
import { adjustFor, gameFor, marketFor, type MarketContext, type OddsStatus } from './market';
import { matchupInputs, matchupsFor, type MatchupContext, type MatchupStatus } from './matchups';
import { openingsAmong } from './depth';
import { formEnabled, formInputs } from './form';
import { readWeekResults } from '@ds-nfl/adapters';
import { recordCompletedWeeks, recordSnapshot, snapshotRow } from './results';
import { priceOpponent, upsideEnabled, upsideView, type UpsideView } from './upside';

export interface MatchupView {
  readonly opponentName: string;
  readonly opponentProjected: number;
  /**
   * 'set': ESPN's projection of the lineup the opponent has set. 'best': the
   * best lineup their roster could field, used for a week that has not started.
   */
  readonly opponentBasis: 'set' | 'best';
  readonly myProjected: number;
  /** Margin if the lineup is left as-is, and after applying the moves. */
  readonly marginNow: number;
  readonly marginAfter: number;
}

/** A player's NFL game for the week, from the betting lines. */
export interface GameLine {
  readonly team: string;
  readonly opponent: string;
  readonly home: boolean;
  /** The team's spread: negative when favored. */
  readonly spread: number;
  /** Points the market expects the team to score. */
  readonly impliedPoints: number;
}

export interface WeekView {
  readonly isSample: boolean;
  /** Key of the league shown; null for the sample. Actions send it back. */
  readonly leagueKey: string | null;
  /** The week being played. `league.week` is the week shown. */
  readonly currentWeek: number;
  readonly finalWeek: number;
  /** True when the week shown has not started yet. */
  readonly isFuture: boolean;
  /** True when every startable player's game has kicked off. */
  readonly allLocked: boolean;
  readonly lockedCount: number;
  readonly matchup: MatchupView | null;
  readonly error: string | null;
  readonly league: {
    readonly name: string;
    readonly format: string;
    readonly season: number;
    readonly week: number;
  };
  readonly optimal: LineupSolution;
  readonly diff: LineupDiff;
  readonly current: readonly SlotAssignment[];
  readonly currentPoints: number;
  /** Claude's or the local model's saved news check for this league and week. */
  readonly news: NewsReport | null;
  /** Whether betting odds are on and loaded for the week. */
  readonly odds: OddsStatus;
  /** Whether NFL matchups are on and loaded for the week. */
  readonly matchups: MatchupStatus;
  /** Players next in line behind an injured teammate their NFL team leans on, by player id. */
  readonly openings: Readonly<Record<string, OpenedRole>>;
  /** Whether a player's own scoring this season is shaping projections. */
  readonly form: { readonly enabled: boolean };
  /** Whether the upside lineup switch is on, and, when on, the lineup with the best chance of winning. */
  readonly upside: { readonly enabled: boolean; readonly view: UpsideView | null };
  /** Last week as played, once recorded: your set lineup, the recommended one, and the best possible. */
  readonly lastResult: {
    readonly week: number;
    readonly set: number;
    readonly recommended: number;
    readonly recommendedFrom: 'app' | 'espn';
    readonly best: number;
  } | null;
  /** Each player's game line, keyed by player id, when odds are on. */
  readonly games: Readonly<Record<string, GameLine>>;
}

/** Everything needed to show, or apply, one week's lineup for one league. */
export interface LineupPlan {
  readonly conn: LeagueConnection;
  readonly key: string;
  readonly reader: EspnReader;
  readonly ref: LeagueRef;
  readonly league: LeagueInfo;
  readonly week: number;
  readonly isFuture: boolean;
  readonly roster: readonly RosterPlayer[];
  /** Optimizer inputs, with betting lines and news findings applied. */
  readonly players: readonly OptimizerPlayer[];
  readonly optimal: LineupSolution;
  readonly news: NewsReport | null;
  readonly market: MarketContext | null;
  readonly oddsStatus: OddsStatus;
  readonly matchups: MatchupContext | null;
  readonly matchupStatus: MatchupStatus;
  /** Your players next in line behind an injured lead teammate; see core/news/depth.ts. */
  readonly openings: ReadonlyMap<string, OpenedRole>;
  readonly formOn: boolean;
  /** Null when the league has no matchup that week (bye, offseason). */
  readonly rawMatchup: Matchup | null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Read a league's roster for a week and compute the recommended lineup.
 *
 * The lineup page and the apply action both call this, so what is applied is
 * exactly what was shown: same week, same betting lines, same news findings.
 * Projections are built in that order: ESPN's, blended with the market's lines,
 * moved a little by the NFL matchup, then scaled by any news finding.
 */
export async function planLineup(key?: string | null, week?: number | null): Promise<LineupPlan | null> {
  const conn = resolveLeague(key);
  if (!conn) return null;
  // Normalized so the scorebug, the page, and the news section, which name the
  // league differently, share one computation per page load.
  return planCached(leagueKey(conn), week ?? null);
}

const planCached = cache(async (key: string, week: number | null): Promise<LineupPlan | null> => {
  const conn = resolveLeague(key);
  if (!conn) return null;

  const reader = new EspnReader({ espnS2: conn.espnS2, swid: conn.swid });
  const ref: LeagueRef = { platform: 'espn', leagueId: conn.leagueId, season: conn.season, teamId: conn.teamId };
  const league = await reader.getLeague(ref);
  const target = await resolveWeek(league, week);
  const isFuture = target > league.currentWeek;
  // Independent reads, in parallel. A missing matchup is normal (bye week,
  // offseason), not an error.
  const [roster, { ctx: market, status: oddsStatus }, rawMatchup, { ctx: matchups, status: matchupStatus }] =
    await Promise.all([
      reader.getRoster(ref, target),
      marketFor(league, target, reader, ref),
      reader.getMatchup(ref, target).catch(() => null),
      matchupsFor(reader, ref, league, target),
    ]);
  const planKey = leagueKey(conn);
  const news = readNewsReport(planKey, target);

  const base: OptimizerPlayer[] = roster.players.map((p) => {
    const m = adjustFor(market, p);
    return {
      gsisId: p.platformPlayerId,
      name: p.name,
      position: p.position,
      eligibleSlots: p.eligibleSlots,
      projectedPoints: m?.blended ?? p.projectedPoints,
      available: p.available,
      ...(p.unavailableReason ? { unavailableReason: p.unavailableReason } : {}),
      // A locked player is pinned to the slot they already hold, so the optimizer
      // cannot propose a move the platform would reject. Nothing is locked in a
      // week that has not started, whatever a player's flag says today.
      ...(p.locked && !isFuture ? { lockedToSlot: p.currentSlot } : {}),
      ...(m ? { market: m } : {}),
    };
  });
  const formOn = await formEnabled();
  const priced = applyForm(
    applyMatchups(base, matchupInputs(matchups, roster.players)),
    formInputs(roster.players, formOn),
  );
  const players = applyNewsFindings(priced, activeFindings(news));
  // Every roster in the league comes from the same ESPN read as yours.
  const openings = openingsAmong([...(await reader.getAllRosters(ref, target)).values()].flat());
  const optimal = optimizeLineup(players, league.rosterSettings);

  // What the app believed before kickoff, kept for training and checking; see results.ts.
  const slotOf = new Map(optimal.starters.flatMap((s) => (s.player ? [[s.player.gsisId, String(s.slot)] as const] : [])));
  const rosterById = new Map(roster.players.map((p) => [p.platformPlayerId, p]));
  recordSnapshot(
    planKey,
    target,
    'lineup',
    players.map((p) => snapshotRow(p, rosterById.get(p.gsisId), 'mine', { slot: slotOf.get(p.gsisId) ?? 'BENCH' })),
  );

  return {
    conn,
    key: planKey,
    reader,
    ref,
    league,
    week: target,
    isFuture,
    roster: roster.players,
    players,
    optimal,
    news,
    market,
    oddsStatus,
    matchups,
    matchupStatus,
    openings,
    formOn,
    rawMatchup,
  };
});

/** The named league's week, or the active league's; the week switch decides which week. */
export const loadWeek = cache(async (key?: string | null, week?: number | null): Promise<WeekView> => {
  if (!resolveLeague(key)) return sampleView(null);

  try {
    const plan = await planLineup(key, week);
    if (!plan) return sampleView(null);
    // Finished weeks are recorded in the background; the page does not wait.
    void recordCompletedWeeks(plan.reader, plan.ref, plan.league, plan.key);
    const last = readWeekResults(plan.key, plan.league.currentWeek - 1);
    const { league, players, optimal, isFuture } = plan;

    const current = currentAssignments(players, plan.roster, league.rosterSettings);
    const diff = diffLineup(current, optimal);
    const currentPoints = round1(current.reduce((s, a) => s + (a.player?.projectedPoints ?? 0), 0));

    const rawMatchup = plan.rawMatchup;

    // Leagues carried over from the single-league store have no names yet, and
    // ESPN leagues can be renamed; keep the switcher's labels current.
    rememberLeagueNames(plan.key, {
      leagueName: league.name,
      ...(rawMatchup?.myTeamName ? { teamName: rawMatchup.myTeamName } : {}),
    });

    const matchup = rawMatchup ? await matchupView(plan, rawMatchup, currentPoints) : null;
    const upsideOn = await upsideEnabled();
    const upside = { enabled: upsideOn, view: upsideOn ? await upsideView(plan) : null };
    const lockedCount = isFuture ? 0 : plan.roster.filter((p) => p.locked).length;

    const games: Record<string, GameLine> = {};
    for (const p of plan.roster) {
      const g = gameFor(plan.market, p.proTeam);
      if (g) {
        games[p.platformPlayerId] = {
          team: g.team,
          opponent: g.opponent,
          home: g.home,
          spread: g.spread,
          impliedPoints: g.impliedPoints,
        };
      }
    }

    return {
      isSample: false,
      leagueKey: plan.key,
      currentWeek: league.currentWeek,
      finalWeek: league.finalWeek,
      isFuture,
      allLocked: lockedCount > 0 && lockedCount === plan.roster.length,
      lockedCount,
      matchup,
      error: null,
      league: {
        name: league.name,
        format: league.formatLabel,
        season: league.season,
        week: plan.week,
      },
      optimal,
      diff,
      current,
      currentPoints,
      news: plan.news,
      odds: plan.oddsStatus,
      matchups: plan.matchupStatus,
      openings: Object.fromEntries(plan.openings),
      form: { enabled: plan.formOn },
      lastResult: last?.lineup ? { week: last.week, ...last.lineup } : null,
      upside,
      games,
    };
  } catch (e) {
    // Fail visibly. The sample roster is shown so the app is still usable, but
    // the error is surfaced rather than swallowed into plausible-looking data.
    const message =
      e instanceof AdapterFailure
        ? describeError(e.error)
        : e instanceof Error
          ? e.message
          : String(e);
    return sampleView(message);
  }
});

/**
 * The matchup in points.
 *
 * For the week being played, the opponent's total is ESPN's projection of the
 * lineup they have set. For a week that has not started their lineup is not
 * really set yet, so the comparison is against the best lineup their roster
 * could field, priced the same way as yours (betting lines and matchups included): the
 * harder number, and the right one to plan against.
 */
async function matchupView(plan: LineupPlan, raw: Matchup, currentPoints: number): Promise<MatchupView> {
  let opponentProjected = raw.opponentProjected;
  let opponentBasis: MatchupView['opponentBasis'] = 'set';

  if (plan.isFuture) {
    const theirs = await plan.reader.getRoster({ ...plan.ref, teamId: raw.opponentTeamId }, plan.week);
    const best = optimizeLineup(priceOpponent(plan, theirs.players), plan.league.rosterSettings);
    opponentProjected = round1(best.projectedPoints);
    opponentBasis = 'best';
  }

  return {
    opponentName: raw.opponentTeamName,
    opponentProjected,
    opponentBasis,
    myProjected: currentPoints,
    marginNow: round1(currentPoints - opponentProjected),
    marginAfter: round1(plan.optimal.projectedPoints - opponentProjected),
  };
}

/**
 * Rebuild the lineup the platform currently has set, in the same slot order the
 * optimizer uses, so the two can be compared slot by slot.
 */
function currentAssignments(
  players: readonly OptimizerPlayer[],
  raw: readonly { platformPlayerId: string; currentSlot: string }[],
  settings: RosterSettings,
): SlotAssignment[] {
  const byId = new Map(players.map((p) => [p.gsisId, p]));
  const starters = raw.filter((r) => r.currentSlot !== 'BENCH' && r.currentSlot !== 'IR');

  // Expand the league's starting slots, then fill each from the players the
  // platform has sitting in that slot.
  const remaining = new Map<string, string[]>();
  for (const r of starters) {
    const list = remaining.get(r.currentSlot) ?? [];
    list.push(r.platformPlayerId);
    remaining.set(r.currentSlot, list);
  }

  const out: SlotAssignment[] = [];
  let index = 0;
  for (const slot of expandSlots(settings)) {
    const queue = remaining.get(slot) ?? [];
    const id = queue.shift();
    remaining.set(slot, queue);
    out.push({ slot, slotIndex: index, player: id ? (byId.get(id) ?? null) : null });
    index++;
  }
  return out;
}

function expandSlots(settings: RosterSettings) {
  // Mirrors expandStartingSlots ordering from the engine.
  const order = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'RB_WR', 'WR_TE', 'OP', 'K', 'DST'] as const;
  const out: (typeof order)[number][] = [];
  for (const slot of order) {
    const n = settings.slots[slot] ?? 0;
    for (let i = 0; i < n; i++) out.push(slot);
  }
  return out;
}

function sampleView(error: string | null): WeekView {
  const s = buildSampleWeek();
  return {
    isSample: true,
    leagueKey: null,
    currentWeek: s.league.week,
    finalWeek: s.league.week,
    isFuture: false,
    allLocked: false,
    lockedCount: 0,
    matchup: {
      opponentName: s.matchup.opponent,
      opponentProjected: s.matchup.opponentProjected,
      opponentBasis: 'set',
      myProjected: s.currentPoints,
      marginNow: s.matchup.marginNow,
      marginAfter: s.matchup.marginAfter,
    },
    error,
    league: {
      name: s.league.name,
      format: s.league.format,
      season: s.league.season,
      week: s.league.week,
    },
    optimal: s.optimal,
    diff: s.diff,
    current: s.currentLineup,
    currentPoints: s.currentPoints,
    news: null,
    odds: { enabled: false, available: false, provider: null, error: null },
    matchups: { enabled: false, available: false, error: null },
    openings: {},
    form: { enabled: false },
    lastResult: null,
    upside: { enabled: false, view: null },
    games: {},
  };
}
