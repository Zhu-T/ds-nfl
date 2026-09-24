/**
 * Loaders for the pages beyond the lineup.
 *
 * Each returns a discriminated result rather than throwing, so a page can render
 * a real explanation instead of an error boundary. Nothing here ever falls back
 * to invented data.
 */

import 'server-only';
import {
  applyForm,
  applyMatchups,
  applyNewsFindings,
  dropCosts,
  expandStartingSlots,
  horizonValues,
  swapValue,
  tradeValue,
  openedRoleNote,
  type DropSuggestion,
  type HorizonValue,
  type NewsFinding,
  type OpenedRole,
  coverageByWeek,
  optimizeLineup,
  rankWaiverCandidates,
  valueToRoster,
  type LineupSlot,
  type OptimizerPlayer,
  type PlayerValue,
  type RosterSettings,
  type WaiverCandidate,
} from '@ds-nfl/core';
import {
  EspnReader,
  resolveLeague,
  leagueKey,
  readNewsReport,
  activeFindings,
  livePendingMoves,
  protectedIds,
  readWebPicks,
  type WebPicksReport,
  type WeekResults,
  describeError,
  gatherPlayerNews,
  AdapterFailure,
  parseEspnScoring,
  type LeagueInfo,
  type LeagueTransaction,
  type LeagueRef,
  type RosterPlayer,
  type GatherResult,
  type GatheredItem,
} from '@ds-nfl/adapters';
import type { ResearchPlayer } from '@ds-nfl/llm';
import { resolveWeek } from './week-choice';
import { adjustFor, gameFor, marketFor, type MarketContext } from './market';
import { searchWords } from './player-search';
import { matchupInputs, matchupsFor, type MatchupContext } from './matchups';
import { openingsAmong } from './depth';
import { horizonFor } from './horizon';
import { recordSnapshot, reviewWeeks, snapshotRow } from './results';
import { planLineup } from './week';
import { ceilingView, type CeilingView } from './upside';
import { seasonOdds, type SeasonOddsView } from './season-odds';
import { formEnabled, formInputs } from './form';

export type Loaded<T> =
  | { state: 'ok'; data: T; key: string }
  | { state: 'disconnected' }
  | { state: 'error'; message: string };

/** The named league, or the active one. The key travels back to the page. */
function connection(key?: string | null) {
  const league = resolveLeague(key);
  if (!league) return null;
  return {
    key: leagueKey(league),
    creds: { espnS2: league.espnS2, swid: league.swid },
    ref: {
      platform: 'espn' as const,
      leagueId: league.leagueId,
      season: league.season,
      teamId: league.teamId,
    },
  };
}

async function load<T>(
  key: string | null | undefined,
  fn: (reader: EspnReader, ref: any, league: LeagueInfo, connKey: string) => Promise<T>,
): Promise<Loaded<T>> {
  const conn = connection(key);
  if (!conn) return { state: 'disconnected' };
  try {
    const reader = new EspnReader(conn.creds);
    const league = await reader.getLeague(conn.ref);
    return { state: 'ok', data: await fn(reader, conn.ref, league, conn.key), key: conn.key };
  } catch (e) {
    const message =
      e instanceof AdapterFailure ? describeError(e.error) : e instanceof Error ? e.message : String(e);
    return { state: 'error', message };
  }
}

function toOptimizer(p: RosterPlayer, market: MarketContext | null = null): OptimizerPlayer {
  // Betting lines are blended in the same way the lineup page does it.
  const m = adjustFor(market, p);
  return {
    ...(m ? { market: m } : {}),
    gsisId: p.platformPlayerId,
    name: p.name,
    position: p.position,
    eligibleSlots: p.eligibleSlots,
    projectedPoints: m?.blended ?? p.projectedPoints,
    available: p.available,
    ...(p.unavailableReason ? { unavailableReason: p.unavailableReason } : {}),
    ...(p.locked ? { lockedToSlot: p.currentSlot } : {}),
  };
}

/**
 * The same player with this week's kickoff lock removed.
 *
 * Locks constrain *this week's lineup*. A pickup or a trade pays off over the
 * weeks that follow, so pricing one with every starter pinned makes every
 * candidate worth exactly zero — which is what the first version of the waiver
 * page reported, as "nobody improves your lineup".
 */
function unlocked(p: RosterPlayer, market: MarketContext | null = null): OptimizerPlayer {
  return toOptimizer({ ...p, locked: false }, market);
}

/** Players priced for the week, unlocked: ESPN's projection, betting lines, the NFL matchup, then recent form. */
function priced(
  players: readonly RosterPlayer[],
  market: MarketContext | null,
  matchups: MatchupContext | null,
  formOn: boolean,
): OptimizerPlayer[] {
  return applyForm(
    applyMatchups(players.map((p) => unlocked(p, market)), matchupInputs(matchups, players)),
    formInputs(players, formOn),
  );
}

/** The week to price, and what shapes its projections: betting lines, NFL matchups, and web news findings. */
async function weekFor(
  reader: EspnReader,
  ref: LeagueRef,
  league: LeagueInfo,
  connKey: string,
  requested?: number | null,
) {
  const week = await resolveWeek(league, requested);
  const [market, matchups, formOn] = await Promise.all([
    marketFor(league, week, reader, ref),
    matchupsFor(reader, ref, league, week),
    formEnabled(),
  ]);
  return {
    week,
    isFuture: week > league.currentWeek,
    findings: activeFindings(readNewsReport(connKey, week)),
    market: market.ctx,
    matchups: matchups.ctx,
    formOn,
  };
}

// ------------------------------------------------------------------ waivers --

export interface WaiverView {
  readonly week: number;
  /** True when pricing a week that has not started. */
  readonly isFuture: boolean;
  readonly lockedOut: boolean;
  readonly candidates: readonly WaiverCandidate[];
  readonly considered: number;
  /** Whether each candidate is an instant add or needs a waiver claim. */
  readonly pickupById: Readonly<Record<string, 'free-agent' | 'waivers'>>;
  readonly proTeamById: Readonly<Record<string, string | null>>;
  /** The saved web picks for this league and week, if checked. */
  readonly webPicks: WebPicksReport | null;
  /** What each available web pick adds to your lineup this week, by player id. */
  readonly pickGains: Readonly<Record<string, number>>;
  /** Every unrostered player weighed, best projected first, as the League AI brief lists them. */
  readonly available: readonly AvailablePlayer[];
  /** Players next in line behind an injured teammate their NFL team leans on, across the league, by id. */
  readonly openings: Readonly<Record<string, OpenedRole>>;
  /** The weeks "across the coming weeks" covers, the week shown first. */
  readonly horizonWeeks: readonly number[];
  /** What each candidate adds to your best lineups across those weeks, by id. */
  readonly horizonById: Readonly<Record<string, HorizonValue>>;
  /** For candidates worth adding: the player whose absence costs your lineups least across those weeks, by candidate id. */
  readonly dropById: Readonly<Record<string, DropSuggestion>>;
  /** What losing each of your players would cost your lineups across those weeks, by player id: the price of using them as the drop. */
  readonly dropCostById: Readonly<Record<string, number>>;
  /** ESPN's rostered +/- and rostered percent for each available player that has them, by id. */
  readonly trendById: Readonly<Record<string, Trend>>;
  /** Your chance of winning this week's matchup and the pickups that raise it most; null without a matchup. */
  readonly ceiling: CeilingView | null;
  /** Your players, for choosing who to drop when adding someone. */
  readonly myRoster: readonly {
    readonly id: string;
    readonly name: string;
    readonly position: string;
    readonly locked: boolean;
    /** Marked never to be dropped. */
    readonly protected: boolean;
  }[];
  /** The FAAB budget and what is left of it; null in leagues that use waiver order. */
  readonly faab: { readonly budget: number; readonly remaining: number } | null;
  /**
   * Roster spots: players held against starting slots plus bench, and whether a
   * pickup can land without dropping anyone. IR does not count as a spot a new
   * player could take.
   */
  readonly spots: { readonly used: number; readonly total: number; readonly room: number };
  /** Claims you have already put in, which ESPN has not settled yet. */
  readonly pending: readonly PendingMove[];
}

export interface PendingMove {
  readonly id: string;
  readonly kind: 'waivers' | 'free-agent';
  readonly week: number;
  readonly bid?: number;
  /** Names, with ids so rows can be matched. */
  readonly adds: readonly { readonly id: string; readonly name: string }[];
  readonly drops: readonly { readonly id: string; readonly name: string }[];
}

export interface Trend {
  /** Change in the percent of ESPN leagues rostering them, in percentage points. */
  readonly change: number;
  readonly rostered: number;
}

/** A rise worth mentioning: managers adding them in at least a quarter-point more of ESPN's leagues. */
export const TRENDING_MIN = 0.25;

export interface AvailablePlayer {
  readonly id: string;
  readonly name: string;
  readonly position: string;
  readonly proTeam: string | null;
  /** This week's projection with web news and betting lines applied, as the ranking uses it. */
  readonly projected: number;
  readonly pickup: 'free-agent' | 'waivers';
  readonly gain: number;
  readonly injury: string | null;
  readonly webPick: boolean;
  /** An injured teammate ahead of them, e.g. "Bijan Robinson, ahead of them at RB, is out". */
  readonly opening: string | null;
  /** What they add to your best lineups across the coming weeks. */
  readonly horizonGain: number;
  /** ESPN's rostered +/-, in percentage points, when known. */
  readonly rosteredChange: number | null;
}

export function loadWaivers(key?: string | null, requestedWeek?: number | null): Promise<Loaded<WaiverView>> {
  return load(key, async (reader, ref, league, connKey) => {
    const { week, isFuture, findings, market, matchups, formOn } = await weekFor(reader, ref, league, connKey, requestedWeek);
    const [roster, freeAgents] = await Promise.all([
      reader.getRoster(ref, week),
      reader.getFreeAgentPool(ref, week),
    ]);

    // Available web picks are always weighed, even outside the usual pool.
    const webPicks = readWebPicks(connKey, week);
    const pooled = new Set(freeAgents.map((p) => p.platformPlayerId));
    const missing = (webPicks?.picks ?? [])
      .filter((p) => p.playerId && (p.status === 'free-agent' || p.status === 'waivers') && !pooled.has(p.playerId))
      .map((p) => p.playerId!);
    const extra = missing.length > 0 ? (await reader.getPlayersByIds(ref, week, missing)).filter((p) => p.pickup) : [];
    const available = [...freeAgents, ...extra];
    // Every roster comes from the same ESPN read as yours.
    const openings = openingsAmong([...[...(await reader.getAllRosters(ref, week)).values()].flat(), ...available]);

    // Web news covers the roster and the top pickups, so both are adjusted.
    const mine = applyNewsFindings(priced(roster.players, market, matchups, formOn), findings);
    const pool = applyNewsFindings(priced(available, market, matchups, formOn), findings);
    // Players you have marked as protected are never named as the one to drop.
    const protectedSet = protectedIds(connKey);
    const ranked = rankWaiverCandidates(mine, pool, league.rosterSettings, protectedSet);

    // Beyond this week: each candidate's value across the coming weeks, and who you would miss least.
    const horizon = await horizonFor(reader, ref, league, week, [...roster.players, ...available]);
    const horizonById = horizonValues(mine, pool, horizon, league.rosterSettings);
    const reach = (c: WaiverCandidate) => horizonById.get(c.player.gsisId)?.total ?? 0;
    const trendById: Record<string, Trend> = {};
    for (const p of available) {
      if (p.percentChange !== undefined) trendById[p.platformPlayerId] = { change: p.percentChange, rostered: p.percentOwned ?? 0 };
    }
    const changeOf = new Map(Object.entries(trendById).map(([id, t]) => [id, t.change]));
    const candidates = [
      ...new Set([
        ...ranked.slice(0, 40),
        ...[...ranked].sort((a, b) => reach(b) - reach(a) || b.lineupGain - a.lineupGain).slice(0, 40),
        // The most added across ESPN, for the trending view: likely streamers.
        ...ranked.filter((c) => (changeOf.get(c.player.gsisId) ?? 0) >= TRENDING_MIN)
          .sort((a, b) => changeOf.get(b.player.gsisId)! - changeOf.get(a.player.gsisId)!)
          .slice(0, 25),
      ]),
    ];
    const droppable = new Set(
      roster.players
        .filter((p) => p.currentSlot !== 'IR' && !protectedSet.has(p.platformPlayerId))
        .map((p) => p.platformPlayerId),
    );
    const dropById: Record<string, DropSuggestion> = {};
    for (const c of candidates.filter((x) => x.lineupGain > 0 || reach(x) > 0).slice(0, 30)) {
      const [least] = dropCosts([...mine, c.player], horizon, league.rosterSettings, droppable);
      if (least) dropById[c.player.gsisId] = least;
    }

    // What every droppable player would cost, so a confirmation can price whichever one is chosen.
    const dropCostById: Record<string, number> = {};
    for (const cost of dropCosts(mine, horizon, league.rosterSettings, droppable)) {
      dropCostById[cost.playerId] = cost.total;
    }

    // The pickups as the app priced them before kickoff, kept for training and checking; see results.ts.
    const availableById = new Map(available.map((p) => [p.platformPlayerId, p]));
    const rankedById = new Map(ranked.map((c) => [c.player.gsisId, c]));
    recordSnapshot(
      connKey,
      week,
      'waivers',
      pool.map((p) => {
        const rp = availableById.get(p.gsisId);
        const c = rankedById.get(p.gsisId);
        const later = horizonById.get(p.gsisId);
        return snapshotRow(p, rp, rp?.pickup ?? 'free-agent', {
          ...(c ? { gain: c.lineupGain } : {}),
          ...(later ? { horizonGain: later.total } : {}),
        });
      }),
    );
    // Playing for the win: the same week's lineup plan, with locks and scores so far.
    const plan = isFuture || week === league.currentWeek ? await planLineup(connKey, week) : null;
    const ceiling = plan ? await ceilingView(plan, pool, available) : null;

    // Claims already in the queue: the roster will not show them until the waiver run.
    // `livePendingMoves` drops the ones ESPN keeps listed but can no longer run.
    const log = await reader.getTransactions(ref).catch(() => []);
    const onRoster = new Set(roster.players.map((p) => p.platformPlayerId));
    const live = livePendingMoves(
      log.filter((t) => t.isMine && (t.kind === 'waivers' || t.kind === 'free-agent')),
      { onRoster },
    );
    const nameOf = (id: string) =>
      [...roster.players, ...available].find((p) => p.platformPlayerId === id)?.name ?? `Player ${id}`;
    const pending: PendingMove[] = live.map((claim) => ({
      id: claim.id,
      kind: claim.kind as 'waivers' | 'free-agent',
      week: claim.week,
      ...(claim.bid !== undefined ? { bid: claim.bid } : {}),
      adds: claim.adds.map((id) => ({ id, name: nameOf(id) })),
      drops: claim.drops.map((id) => ({ id, name: nameOf(id) })),
    }));

    // Dropping and bidding need your own roster and, in FAAB leagues, what is left of the budget.
    const teams = league.faabBudget > 0 ? await reader.getTeams(ref).catch(() => []) : [];
    const myTeam = teams.find((t) => t.isMine);
    const faab =
      league.faabBudget > 0
        ? { budget: league.faabBudget, remaining: Math.max(0, league.faabBudget - (myTeam?.faabSpent ?? 0)) }
        : null;

    const pickupById: Record<string, 'free-agent' | 'waivers'> = {};
    const proTeamById: Record<string, string | null> = {};
    for (const p of available) {
      if (p.pickup) pickupById[p.platformPlayerId] = p.pickup;
      proTeamById[p.platformPlayerId] = p.proTeam;
    }

    return {
      week,
      isFuture,
      // If every slot is frozen, nobody can help this week regardless of value.
      lockedOut: !isFuture && roster.players.length > 0 && roster.players.every((p) => p.locked),
      candidates,
      considered: available.length,
      pickupById,
      proTeamById,
      webPicks,
      pickGains: Object.fromEntries(
        ranked.filter((c) => webPicks?.picks.some((p) => p.playerId === c.player.gsisId)).map((c) => [c.player.gsisId, c.lineupGain]),
      ),
      available: availablePlayers(available, ranked, webPicks, openings, horizonById),
      openings: Object.fromEntries(openings),
      horizonWeeks: horizon.weeks,
      horizonById: Object.fromEntries(horizonById),
      dropById,
      dropCostById,
      trendById,
      ceiling,
      pending,
      spots: rosterSpots(league.rosterSettings, roster.players),
      myRoster: roster.players.map((p) => ({
        id: p.platformPlayerId,
        name: p.name,
        position: p.position,
        locked: p.locked && !isFuture,
        protected: protectedSet.has(p.platformPlayerId),
      })),
      faab,
    };
  });
}

/** The waiver pool as plain rows: adjusted projection and lineup gain from the ranking, status from ESPN. */
function availablePlayers(
  pool: readonly RosterPlayer[],
  ranked: readonly WaiverCandidate[],
  webPicks: WebPicksReport | null,
  openings: ReadonlyMap<string, OpenedRole>,
  horizonById: ReadonlyMap<string, HorizonValue>,
): AvailablePlayer[] {
  const rankedById = new Map(ranked.map((c) => [c.player.gsisId, c]));
  const picked = new Set((webPicks?.picks ?? []).flatMap((p) => (p.playerId ? [p.playerId] : [])));
  return pool
    .flatMap((p) => {
      const c = rankedById.get(p.platformPlayerId);
      if (!c || !p.pickup) return [];
      return [
        {
          id: p.platformPlayerId,
          name: p.name,
          position: p.position,
          proTeam: p.proTeam,
          projected: c.player.projectedPoints,
          pickup: p.pickup,
          gain: c.lineupGain,
          injury: p.unavailableReason ?? null,
          webPick: picked.has(p.platformPlayerId),
          opening: openings.has(p.platformPlayerId) ? openedRoleNote(openings.get(p.platformPlayerId)!, p.position) : null,
          horizonGain: horizonById.get(p.platformPlayerId)?.total ?? 0,
          rosteredChange: p.percentChange ?? null,
        },
      ];
    })
    .sort((a, b) => b.projected - a.projected);
}

// ------------------------------------------------------------------ players --

export type OwnerKind = 'mine' | 'team' | 'waivers' | 'free-agent';

export interface PlayerRow {
  readonly id: string;
  readonly name: string;
  readonly position: string;
  readonly proTeam: string | null;
  readonly projected: number;
  /** Who has him: "Your roster", another team's name, "Waivers", or "Free agent". */
  readonly owner: string;
  readonly ownerKind: OwnerKind;
  readonly note: string | null;
}

export interface PlayersView {
  readonly week: number;
  readonly rows: readonly PlayerRow[];
  readonly rosteredCount: number;
  readonly unrosteredCount: number;
}

/**
 * The whole league, not just your corner of it.
 *
 * The first version listed only your roster plus unrostered players, so every
 * player who was not yours read as "Available": nothing on another team was
 * ever shown, and waiver players were indistinguishable from instant adds.
 */
export function loadPlayers(key?: string | null, requestedWeek?: number | null): Promise<Loaded<PlayersView>> {
  return load(key, async (reader, ref, league, connKey) => {
    const { week } = await weekFor(reader, ref, league, connKey, requestedWeek);
    const [teams, all, freeAgents] = await Promise.all([
      reader.getTeams(ref),
      reader.getAllRosters(ref, week),
      reader.getFreeAgentPool(ref, week, { byProjection: 200, byOwnership: 100 }),
    ]);
    const teamName = new Map(teams.map((t) => [t.teamId, t.name]));

    const rostered: PlayerRow[] = [];
    for (const [teamId, players] of all) {
      const mine = teamId === String(ref.teamId);
      const owner = mine ? 'Your roster' : (teamName.get(teamId) ?? `Team ${teamId}`);
      for (const p of players) rostered.push(row(p, owner, mine ? 'mine' : 'team'));
    }

    // The free-agent query only returns FREEAGENT or WAIVERS statuses, so every
    // player here is one or the other.
    const unrostered = freeAgents.map((p) =>
      p.pickup === 'waivers' ? row(p, 'Waivers', 'waivers') : row(p, 'Free agent', 'free-agent'),
    );

    return {
      week,
      rows: [...rostered, ...unrostered].sort((x, y) => y.projected - x.projected),
      rosteredCount: rostered.length,
      unrosteredCount: unrostered.length,
    };
  });
}

function row(p: RosterPlayer, owner: string, ownerKind: OwnerKind): PlayerRow {
  return {
    id: p.platformPlayerId,
    name: p.name,
    position: p.position,
    proTeam: p.proTeam,
    projected: p.projectedPoints,
    owner,
    ownerKind,
    note: p.unavailableReason ?? (p.locked ? 'Locked' : null),
  };
}

// --------------------------------------------------------------- one player --

export interface PlayerEvaluation {
  readonly week: number;
  readonly isFuture: boolean;
  readonly id: string;
  readonly name: string;
  readonly position: string;
  readonly proTeam: string | null;
  /** Where the player is now: "Your roster", another team's name, "Waivers", or "Free agent". */
  readonly owner: string;
  readonly ownerKind: OwnerKind;
  /** ESPN's projection, and the one the app uses: betting lines and news applied. */
  readonly espnProjection: number;
  readonly projection: number;
  readonly market: { readonly blended: number } | null;
  readonly news: { readonly status: string; readonly summary: string } | null;
  /** What they have actually scored this season, and how it moved the projection. */
  readonly form: {
    readonly average: number;
    readonly games: number;
    readonly factor: number;
    readonly pricedByMarket: boolean;
  } | null;
  /** A D/ST's opponent, how D/STs have scored against it over their projections, and how that moved the projection; null otherwise. */
  readonly matchup: {
    readonly opponent: string;
    readonly home: boolean;
    readonly ratio: number;
    readonly rank: number;
    readonly teams: number;
    readonly games: number;
    readonly factor: number;
    readonly pricedByMarket: boolean;
  } | null;
  readonly injury: string | null;
  /** An injured teammate ahead of them at their position; context, not a projection change. */
  readonly opening: string | null;
  readonly game: {
    readonly opponent: string;
    readonly home: boolean;
    readonly impliedPoints: number;
    readonly spread: number;
  } | null;
  readonly value: PlayerValue;
  /**
   * This week and the next few: what they add to your best lineups, or for one
   * of yours what losing them costs, and who to drop for them.
   */
  readonly horizon: {
    readonly weeks: readonly number[];
    readonly total: number;
    readonly byWeek: readonly number[];
    readonly drop: DropSuggestion | null;
  };
  /** For another team's player: the one-for-one trade that helps both lineups most, if any does. */
  readonly trade: { readonly give: string; readonly myGain: number; readonly theirGain: number } | null;
}

export interface PlayerMatch {
  readonly id: string;
  readonly name: string;
  readonly position: string;
  readonly proTeam: string | null;
  readonly owner: string;
}

export type EvaluationResult =
  | { readonly kind: 'evaluated'; readonly evaluation: PlayerEvaluation }
  | { readonly kind: 'choose'; readonly matches: readonly PlayerMatch[] }
  | { readonly kind: 'none'; readonly message: string };

const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);
const bareName = (name: string) => searchWords(name).filter((w) => !NAME_SUFFIXES.has(w));

/**
 * One player, by name or (once chosen from several matches) by ESPN id: where
 * they are, their projection with every adjustment the app makes, and what they
 * would add to your best lineup this week, or cost it if they are yours. Valued
 * as if no game had kicked off, like the waiver ranking, so the numbers agree.
 */
export function evaluatePlayer(
  key: string | null | undefined,
  requestedWeek: number | null,
  query: string,
  id?: string,
  /** Findings to apply for this evaluation only, e.g. from reading the player's news. */
  extraFindings: readonly NewsFinding[] = [],
): Promise<Loaded<EvaluationResult>> {
  return load(key, async (reader, ref, league, connKey) => {
    const { week, isFuture, findings, market, matchups, formOn } = await weekFor(reader, ref, league, connKey, requestedWeek);
    const [teams, all] = await Promise.all([reader.getTeams(ref), reader.getAllRosters(ref, week)]);
    const myId = String(ref.teamId);
    const teamName = new Map(teams.map((t) => [String(t.teamId), t.name]));
    const teamOf = new Map<string, string>();
    for (const [teamId, players] of all) for (const p of players) teamOf.set(p.platformPlayerId, String(teamId));
    const whereIs = (p: RosterPlayer): { owner: string; ownerKind: OwnerKind } => {
      const teamId = teamOf.get(p.platformPlayerId) ?? p.onTeamId;
      if (teamId === myId) return { owner: 'Your roster', ownerKind: 'mine' };
      if (teamId) return { owner: teamName.get(teamId) ?? `Team ${teamId}`, ownerKind: 'team' };
      return p.pickup === 'waivers' ? { owner: 'Waivers', ownerKind: 'waivers' } : { owner: 'Free agent', ownerKind: 'free-agent' };
    };

    let targetId = id;
    if (!targetId) {
      // Rostered players are matched here, so "jamarr" finds Ja'Marr Chase;
      // ESPN's name search adds everyone else.
      const wanted = bareName(query);
      if (wanted.length === 0) return { kind: 'none', message: 'Type a player’s name.' };
      const covers = (name: string) => wanted.every((w) => bareName(name).some((word) => word.startsWith(w)));
      const local = [...all.values()].flat().filter((p) => covers(p.name));
      const remote = await reader.searchPlayersByName(ref, week, query, 10).catch(() => [] as RosterPlayer[]);
      const seen = new Set<string>();
      const matches = [...local, ...remote].filter((p) => !seen.has(p.platformPlayerId) && seen.add(p.platformPlayerId));
      const exact = matches.filter((p) => bareName(p.name).join(' ') === wanted.join(' '));
      if (matches.length === 0) return { kind: 'none', message: `No player named “${query.trim()}” was found.` };
      if (exact.length === 1 || matches.length === 1) {
        targetId = (exact.length === 1 ? exact[0]! : matches[0]!).platformPlayerId;
      } else {
        return {
          kind: 'choose',
          matches: matches.slice(0, 8).map((p) => ({
            id: p.platformPlayerId,
            name: p.name,
            position: p.position,
            proTeam: p.proTeam,
            owner: whereIs(p).owner,
          })),
        };
      }
    }

    const [found] = await reader.getPlayersByIds(ref, week, [targetId]);
    if (!found) return { kind: 'none', message: 'ESPN has no player with that id.' };

    const settings = league.rosterSettings;
    const inEffect = [...findings.filter((f) => !extraFindings.some((x) => x.playerId === f.playerId)), ...extraFindings];
    const mine = applyNewsFindings(priced(all.get(myId) ?? [], market, matchups, formOn), inEffect);
    const [target] = applyNewsFindings(priced([found], market, matchups, formOn), inEffect);
    const opening = openingsAmong([...[...all.values()].flat(), found]).get(found.platformPlayerId);
    const where = whereIs(found);

    // Beyond this week, as the waiver list values it.
    const myRoster = all.get(myId) ?? [];
    const horizon = await horizonFor(reader, ref, league, week, [...myRoster, found]);
    const onRoster = myRoster.some((p) => p.platformPlayerId === found.platformPlayerId);
    let later: PlayerEvaluation['horizon'];
    if (onRoster) {
      const [cost] = dropCosts(mine, horizon, settings, new Set([found.platformPlayerId]));
      later = { weeks: horizon.weeks, total: cost?.total ?? 0, byWeek: cost?.byWeek ?? [], drop: null };
    } else {
      const value = horizonValues(mine, [target!], horizon, settings).get(found.platformPlayerId);
      const guarded = protectedIds(connKey);
      const droppable = new Set(
        myRoster.filter((p) => p.currentSlot !== 'IR' && !guarded.has(p.platformPlayerId)).map((p) => p.platformPlayerId),
      );
      const [least] = dropCosts([...mine, target!], horizon, settings, droppable);
      later = { weeks: horizon.weeks, total: value?.total ?? 0, byWeek: value?.byWeek ?? [], drop: least ?? null };
    }

    // For another team's player, the trade the Trades page would propose for them.
    let trade: PlayerEvaluation['trade'] = null;
    const theirId = teamOf.get(found.platformPlayerId) ?? found.onTeamId;
    if (where.ownerKind === 'team' && theirId) {
      const theirs = priced(all.get(theirId) ?? [], market, matchups, formOn);
      const get = theirs.find((p) => p.gsisId === found.platformPlayerId);
      if (get) {
        const myBase = optimizeLineup(mine, settings).projectedPoints;
        const theirBase = optimizeLineup(theirs, settings).projectedPoints;
        for (const give of topBy(mine, 10)) {
          const myGain = round1(optimizeLineup(swap(mine, give, get), settings).projectedPoints - myBase);
          const theirGain = round1(optimizeLineup(swap(theirs, get, give), settings).projectedPoints - theirBase);
          if (myGain > 0.05 && theirGain > 0.05 && myGain > (trade?.myGain ?? 0)) {
            trade = { give: give.name, myGain, theirGain };
          }
        }
      }
    }

    const game = gameFor(market, found.proTeam);
    return {
      kind: 'evaluated',
      evaluation: {
        week,
        isFuture,
        id: found.platformPlayerId,
        name: found.name,
        position: found.position,
        proTeam: found.proTeam,
        ...where,
        espnProjection: found.projectedPoints,
        projection: target!.projectedPoints,
        market: target!.market ? { blended: target!.market.blended } : null,
        news: target!.news ? { status: target!.news.status, summary: target!.news.summary } : null,
        form: target!.form
          ? {
              average: target!.form.average,
              games: target!.form.games,
              factor: target!.form.factor,
              pricedByMarket: target!.form.pricedByMarket,
            }
          : null,
        matchup: target!.matchup
          ? {
              opponent: target!.matchup.opponent,
              home: target!.matchup.home,
              ratio: target!.matchup.ratio,
              rank: target!.matchup.rank,
              teams: target!.matchup.teams,
              games: target!.matchup.games,
              factor: target!.matchup.factor,
              pricedByMarket: target!.matchup.pricedByMarket,
            }
          : null,
        injury: found.unavailableReason ?? null,
        opening: opening ? openedRoleNote(opening, found.position) : null,
        game: game
          ? { opponent: game.opponent, home: game.home, impliedPoints: game.impliedPoints, spread: game.spread }
          : null,
        value: valueToRoster(mine, target!, settings),
        horizon: later,
        trade,
      },
    };
  });
}

/** How far back the web search on one player looks, as the news check does. */
const WEB_NEWS_DAYS = 7;
const WEB_NEWS_TTL_MS = 10 * 60 * 1000;
const webNewsCache = new Map<string, { at: number; gathered: Promise<GatherResult> }>();

/** One player's web news, kept ten minutes so the AI read uses what the page just showed. */
function gatherFor(player: RosterPlayer, ollamaApiKey?: string): Promise<GatherResult> {
  const cacheKey = `${player.platformPlayerId}|${ollamaApiKey ? 'with-search' : 'free'}`;
  const hit = webNewsCache.get(cacheKey);
  if (hit && Date.now() - hit.at < WEB_NEWS_TTL_MS) return hit.gathered;
  const gathered = gatherPlayerNews([{ id: player.platformPlayerId, name: player.name, position: player.position }], {
    days: WEB_NEWS_DAYS,
    headlinesPerPlayer: 8,
    ollamaApiKey,
  });
  webNewsCache.set(cacheKey, { at: Date.now(), gathered });
  gathered.catch(() => webNewsCache.delete(cacheKey));
  return gathered;
}

export interface PlayerNewsInputs {
  readonly leagueName: string;
  readonly week: number;
  readonly player: ResearchPlayer;
  readonly items: readonly GatheredItem[];
}

/**
 * What an AI reads about one player: their line, with any injured teammate
 * ahead of them, and the web news gathered for them.
 */
export function playerNewsInputs(
  key: string | null | undefined,
  requestedWeek: number | null,
  id: string,
  ollamaApiKey?: string,
): Promise<Loaded<PlayerNewsInputs | null>> {
  return load(key, async (reader, ref, league) => {
    const week = await resolveWeek(league, requestedWeek);
    const [[player], all] = await Promise.all([reader.getPlayersByIds(ref, week, [id]), reader.getAllRosters(ref, week)]);
    if (!player) return null;
    const rostered = [...all.values()].flat();
    const mine = (all.get(String(ref.teamId)) ?? []).some((p) => p.platformPlayerId === id);
    const onTeam = rostered.some((p) => p.platformPlayerId === id);
    const opening = openingsAmong([...rostered, player]).get(id);
    const gathered = await gatherFor(player, ollamaApiKey);
    return {
      leagueName: league.name,
      week,
      player: {
        id,
        name: player.name,
        position: player.position,
        proTeam: player.proTeam,
        projected: player.projectedPoints,
        role: mine ? 'rostered' : onTeam ? 'other' : 'pickup',
        ...(opening ? { context: openedRoleNote(opening, player.position) } : {}),
      },
      items: gathered.items,
    };
  });
}

export interface PlayerWebNews {
  readonly days: number;
  readonly items: readonly {
    readonly url: string;
    readonly source: string;
    /** YYYY-MM-DD. */
    readonly published: string;
    readonly title: string;
    readonly text?: string;
  }[];
  /** Where it searched, e.g. ["ESPN", "Google News", "Ollama web search"]. */
  readonly sourcesUsed: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * The last week of news on one player from the web: ESPN's player updates,
 * Google News headlines that name them, and Ollama web search when a key is
 * saved. The player is read by id first, so the search uses ESPN's spelling of
 * the name. For reading only: nothing here changes a projection.
 */
export function playerWebNews(
  key: string | null | undefined,
  requestedWeek: number | null,
  id: string,
  ollamaApiKey?: string,
): Promise<Loaded<PlayerWebNews | null>> {
  return load(key, async (reader, ref, league) => {
    const week = await resolveWeek(league, requestedWeek);
    const [player] = await reader.getPlayersByIds(ref, week, [id]);
    if (!player) return null;
    const gathered = await gatherFor(player, ollamaApiKey);
    return {
      days: WEB_NEWS_DAYS,
      items: gathered.items.slice(0, 12).map((i) => ({
        url: i.url,
        source: i.source,
        published: i.published,
        title: i.title,
        ...(i.text ? { text: i.text.length > 280 ? `${i.text.slice(0, 280).trimEnd()}…` : i.text } : {}),
      })),
      sourcesUsed: gathered.sourcesUsed,
      warnings: gathered.warnings,
    };
  });
}

/** One named one-for-one trade: what it does to your best lineup this week and ahead, and to theirs this week. */
export interface TradeWhatIf {
  readonly give: string;
  readonly get: string;
  readonly owner: string;
  readonly weeks: readonly number[];
  readonly mine: HorizonValue;
  readonly theirs: number;
}

/**
 * Trading `giveId` (yours) for `getId` (another team's), priced as the Trades
 * page prices it. Null when the players are not where the trade needs them.
 */
export function tradeWhatIf(
  key: string | null | undefined,
  requestedWeek: number | null,
  giveId: string,
  getId: string,
): Promise<Loaded<TradeWhatIf | null>> {
  return load(key, async (reader, ref, league, connKey) => {
    const { week, findings, market, matchups, formOn } = await weekFor(reader, ref, league, connKey, requestedWeek);
    const [teams, all] = await Promise.all([reader.getTeams(ref), reader.getAllRosters(ref, week)]);
    const myId = String(ref.teamId);
    const mineRoster = all.get(myId) ?? [];
    const theirEntry = [...all].find(([teamId, ps]) => String(teamId) !== myId && ps.some((p) => p.platformPlayerId === getId));
    if (!theirEntry || !mineRoster.some((p) => p.platformPlayerId === giveId)) return null;
    const [theirId, theirRoster] = theirEntry;
    const mine = applyNewsFindings(priced(mineRoster, market, matchups, formOn), findings);
    const theirs = priced(theirRoster, market, matchups, formOn);
    const give = mine.find((p) => p.gsisId === giveId)!;
    const get = theirs.find((p) => p.gsisId === getId)!;
    const horizon = await horizonFor(reader, ref, league, week, [...mineRoster, ...theirRoster]);
    const settings = league.rosterSettings;
    return {
      give: give.name,
      get: get.name,
      owner: teams.find((t) => String(t.teamId) === String(theirId))?.name ?? `Team ${theirId}`,
      weeks: horizon.weeks,
      mine: swapValue(mine, giveId, get, horizon, settings),
      theirs: swapValue(theirs, getId, give, { weeks: [week], outlooks: horizon.outlooks }, settings).total,
    };
  });
}

// ------------------------------------------------------------------- trades --

export interface TradeIdea {
  readonly opponentTeam: string;
  readonly give: string;
  /** True when the player you would give up is protected: the trade is still shown and valued, but cannot be drafted. */
  readonly giveProtected: boolean;
  readonly giveProjected: number;
  readonly get: string;
  readonly getProjected: number;
  readonly myGain: number;
  readonly theirGain: number;
}

export interface TradesView {
  readonly week: number;
  readonly ideas: readonly TradeIdea[];
  readonly evaluated: number;
  readonly myTeam: string;
  readonly isFuture: boolean;
}

export function loadTrades(key?: string | null, requestedWeek?: number | null): Promise<Loaded<TradesView>> {
  return load(key, async (reader, ref, league, connKey) => {
    const { week, isFuture, findings, market, matchups, formOn } = await weekFor(reader, ref, league, connKey, requestedWeek);
    const [teams, all] = await Promise.all([
      reader.getTeams(ref),
      reader.getAllRosters(ref, week),
    ]);

    const settings = league.rosterSettings;
    const mine = applyNewsFindings(priced(all.get(ref.teamId) ?? [], market, matchups, formOn), findings);
    const myBase = optimizeLineup(mine, settings).projectedPoints;

    // Protected players are still weighed and shown; the pitch is what is withheld.
    const guarded = protectedIds(connKey);
    const ideas: TradeIdea[] = [];
    let evaluated = 0;

    for (const team of teams) {
      if (team.isMine) continue;
      const theirs = priced(all.get(team.teamId) ?? [], market, matchups, formOn);
      if (theirs.length === 0) continue;
      const theirBase = optimizeLineup(theirs, settings).projectedPoints;

      // One-for-one only, and only among players who could plausibly matter.
      for (const give of topBy(mine, 10)) {
        for (const get of topBy(theirs, 10)) {
          evaluated++;
          const myAfter = swap(mine, give, get);
          const theirAfter = swap(theirs, get, give);
          const myGain = round1(optimizeLineup(myAfter, settings).projectedPoints - myBase);
          const theirGain = round1(optimizeLineup(theirAfter, settings).projectedPoints - theirBase);

          // Only propose trades the other manager should rationally accept.
          if (myGain <= 0.05 || theirGain <= 0.05) continue;

          ideas.push({
            opponentTeam: team.name,
            give: give.name,
            giveProtected: guarded.has(give.gsisId),
            giveProjected: give.projectedPoints,
            get: get.name,
            getProjected: get.projectedPoints,
            myGain,
            theirGain,
          });
        }
      }
    }

    ideas.sort((a, b) => b.myGain - a.myGain);
    const myTeam = teams.find((t) => t.isMine)?.name ?? 'My team';
    return { week, ideas: ideas.slice(0, 25), evaluated, myTeam, isFuture };
  });
}

function topBy(players: readonly OptimizerPlayer[], n: number): OptimizerPlayer[] {
  return [...players].sort((a, b) => b.projectedPoints - a.projectedPoints).slice(0, n);
}

function swap(
  roster: readonly OptimizerPlayer[],
  out: OptimizerPlayer,
  incoming: OptimizerPlayer,
): OptimizerPlayer[] {
  return [...roster.filter((p) => p.gsisId !== out.gsisId), incoming];
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ------------------------------------------------------------------ scoring --

export interface ScoringRow {
  readonly statId: number;
  readonly points: number;
  readonly overrides: string | null;
}

export interface SettingsView {
  readonly league: LeagueInfo;
  readonly rosterSettings: RosterSettings;
  readonly scoring: readonly ScoringRow[];
  readonly scoredRuleCount: number;
}

/** Weeks the roster planner looks ahead, the week shown included. */
export const PLAN_WEEKS = 6;

export interface SeasonWeek {
  readonly week: number;
  /** Starting slots the roster cannot fill that week. */
  readonly short: readonly string[];
  /** Players on bye or out that week. */
  readonly missing: readonly { readonly name: string; readonly reason: string }[];
  /** The best lineup the roster could field, on rest-of-season rates. */
  readonly projected: number;
  /** The best available player for each hole, if one plays that week. */
  readonly covers: readonly {
    readonly slot: string;
    readonly name: string;
    readonly position: string;
    readonly perGame: number;
    readonly pickup: 'free-agent' | 'waivers';
  }[];
}

export interface SeasonView {
  readonly weeks: readonly SeasonWeek[];
  /** The week the plan starts from. */
  readonly from: number;
  /** Playoff odds for every team; null when the league does not publish playoff settings. */
  readonly odds: SeasonOddsView | null;
}

/** The coming weeks: where byes and injuries leave the roster short, and who could cover. */
export function loadSeason(key?: string | null, requestedWeek?: number | null): Promise<Loaded<SeasonView>> {
  return load(key, async (reader, ref, league, connKey) => {
    const { week } = await weekFor(reader, ref, league, connKey, requestedWeek);
    const [roster, pool] = await Promise.all([reader.getRoster(ref, week), reader.getFreeAgentPool(ref, week)]);
    const horizon = await horizonFor(reader, ref, league, week, [...roster.players, ...pool], PLAN_WEEKS);

    const coveragePlayer = (p: RosterPlayer) => ({
      gsisId: p.platformPlayerId,
      name: p.name,
      position: p.position,
      eligibleSlots: p.eligibleSlots,
      perGame: horizon.outlooks.get(p.platformPlayerId)?.perGame ?? p.projectedPoints,
      // An IR player cannot be started at all.
      available: p.available && p.currentSlot !== 'IR',
      ...(p.unavailableReason ? { unavailableReason: p.unavailableReason } : {}),
      offWeeks: horizon.outlooks.get(p.platformPlayerId)?.offWeeks ?? new Set<number>(),
    });

    const mine = roster.players.map(coveragePlayer);
    const free = pool.filter((p) => p.pickup).map((p) => ({ ...coveragePlayer(p), pickup: p.pickup! }));
    const weeks = coverageByWeek(mine, horizon.weeks, league.rosterSettings).map((w) => ({
      week: w.week,
      short: w.short.map(String),
      missing: w.missing,
      projected: w.projected,
      covers: [...new Set<LineupSlot>(w.short)].flatMap((slot) => {
        const best = free
          .filter((f) => f.available && !f.offWeeks.has(w.week) && (f.eligibleSlots ?? []).includes(slot))
          .sort((a, b) => b.perGame - a.perGame)[0];
        return best
          ? [{ slot: String(slot), name: best.name, position: best.position, perGame: round1(best.perGame), pickup: best.pickup }]
          : [];
      }),
    }));
    const odds = await seasonOdds(reader, ref, league, week).catch(() => null);
    return { weeks, from: week, odds };
  });
}

export interface TradeOfferValue {
  readonly otherTeam: string;
  /** The players moving, with the projections the app prices them at. */
  readonly incoming: readonly { readonly name: string; readonly position: string; readonly projected: number }[];
  readonly outgoing: readonly { readonly name: string; readonly position: string; readonly projected: number }[];
  /** What it does to your best lineups: this week, and across the weeks valued. */
  readonly myThisWeek: number;
  readonly myTotal: number;
  readonly weeks: readonly number[];
  /** What it does to theirs, this week. */
  readonly theirThisWeek: number;
  /** Positions where your depth changes, e.g. "2 RBs instead of 3". */
  readonly depth: readonly string[];
}

export interface PendingRow {
  readonly id: string;
  readonly kind: 'waivers' | 'free-agent' | 'trade' | 'lineup' | 'other';
  readonly status: 'pending' | 'executed' | 'canceled' | 'failed';
  readonly failure?: string;
  readonly week: number;
  readonly at: string | null;
  readonly bid?: number;
  readonly adds: readonly string[];
  readonly drops: readonly string[];
  /** False when the claim can no longer happen: the drop has gone, or the add already landed. */
  readonly live: boolean;
  /** For a trade offered to you: both sides valued. */
  readonly trade?: TradeOfferValue;
}

export interface PendingView {
  readonly pending: readonly PendingRow[];
  /** What has settled lately, newest first: how a claim actually ended. */
  readonly settled: readonly PendingRow[];
  /** When ESPN settles claims, from the league's own settings. */
  readonly waiverRun: { readonly days: readonly string[]; readonly hour: number } | null;
  /** When this page read ESPN. */
  readonly readAt: string;
}

/** Moves waiting to happen, and the ones that have just settled. */
export function loadPending(key?: string | null): Promise<Loaded<PendingView>> {
  return load(key, async (reader, ref, league, connKey) => {
    const [log, roster] = await Promise.all([reader.getTransactions(ref), reader.getRoster(ref, league.currentWeek)]);
    // Trades offered to you are proposed by the other manager, so "involves me" rather than "mine".
    const mine = log.filter((t) => t.involvesMe && t.kind !== 'lineup');

    // Names for every player named in the rows shown.
    const shown = [...mine.filter((t) => t.status === 'pending'), ...settledFirst(mine).slice(0, 8)];
    const ids = [...new Set(shown.flatMap((t) => [...t.adds, ...t.drops]))];
    const known = new Map(roster.players.map((p) => [p.platformPlayerId, p.name]));
    const missing = ids.filter((id) => !known.has(id));
    for (const p of missing.length > 0 ? await reader.getPlayersByIds(ref, league.currentWeek, missing).catch(() => []) : []) {
      known.set(p.platformPlayerId, p.name);
    }
    const onRoster = new Set(roster.players.map((p) => p.platformPlayerId));
    const liveIds = new Set(livePendingMoves(mine, { onRoster }).map((t) => t.id));
    const row = (t: (typeof mine)[number]): PendingRow => ({
      id: t.id,
      kind: t.kind,
      status: t.status,
      ...(t.failure ? { failure: t.failure } : {}),
      week: t.week,
      at: t.at,
      ...(t.bid !== undefined ? { bid: t.bid } : {}),
      adds: t.adds.map((id) => known.get(id) ?? `Player ${id}`),
      drops: t.drops.map((id) => known.get(id) ?? `Player ${id}`),
      live: liveIds.has(t.id),
    });

    // Each offer valued on both sides, so the page and the model argue from the same numbers.
    const offers = new Map<string, TradeOfferValue>();
    for (const t of mine.filter((x) => x.kind === 'trade' && x.status === 'pending' && liveIds.has(x.id))) {
      const valued = await tradeOfferValue(reader, ref, league, connKey, t).catch(() => null);
      if (valued) offers.set(t.id, valued);
    }

    return {
      pending: mine
        .filter((t) => t.status === 'pending')
        .map((t) => ({ ...row(t), ...(offers.has(t.id) ? { trade: offers.get(t.id)! } : {}) })),
      settled: settledFirst(mine).slice(0, 8).map(row),
      waiverRun: league.waiverRun,
      readAt: new Date().toISOString(),
    };
  });
}

/**
 * A trade offer priced on both sides, the way the Trades page prices its ideas:
 * your lineups across the coming weeks, and theirs for the week in play.
 */
async function tradeOfferValue(
  reader: EspnReader,
  ref: any,
  league: LeagueInfo,
  connKey: string,
  offer: LeagueTransaction,
): Promise<TradeOfferValue | null> {
  const { week, findings, market, matchups, formOn } = await weekFor(reader, ref, league, connKey, null);
  const [teams, all] = await Promise.all([reader.getTeams(ref), reader.getAllRosters(ref, week)]);
  const myId = String(ref.teamId);
  const theirId = offer.otherTeamId ?? offer.teamId;
  const myRoster = all.get(myId) ?? [];
  const theirRoster = all.get(theirId) ?? [];
  if (myRoster.length === 0 || theirRoster.length === 0) return null;

  const mine = applyNewsFindings(priced(myRoster, market, matchups, formOn), findings);
  const theirs = priced(theirRoster, market, matchups, formOn);
  const incoming = theirs.filter((p) => offer.adds.includes(p.gsisId));
  const outgoing = mine.filter((p) => offer.drops.includes(p.gsisId));
  if (incoming.length === 0 && outgoing.length === 0) return null;

  const horizon = await horizonFor(reader, ref, league, week, [...myRoster, ...theirRoster]);
  const settings = league.rosterSettings;
  const myValue = tradeValue(mine, offer.drops, incoming, horizon, settings);
  const theirValue = tradeValue(theirs, offer.adds, outgoing, { weeks: [week], outlooks: horizon.outlooks }, settings);

  // Where the trade changes how many you hold at a position, which a raw points total hides.
  const before = new Map<string, number>();
  for (const p of mine) before.set(p.position, (before.get(p.position) ?? 0) + 1);
  const after = new Map(before);
  for (const p of outgoing) after.set(p.position, (after.get(p.position) ?? 0) - 1);
  for (const p of incoming) after.set(p.position, (after.get(p.position) ?? 0) + 1);
  const depth = [...after]
    .filter(([position, count]) => count !== before.get(position))
    .map(([position, count]) => `${count} ${position}${count === 1 ? '' : 's'} instead of ${before.get(position) ?? 0}`);

  const row = (p: OptimizerPlayer) => ({ name: p.name, position: p.position, projected: round1(p.projectedPoints) });
  return {
    otherTeam: teams.find((t) => String(t.teamId) === String(theirId))?.name ?? `Team ${theirId}`,
    incoming: incoming.map(row),
    outgoing: outgoing.map(row),
    myThisWeek: myValue.byWeek[0] ?? 0,
    myTotal: myValue.total,
    weeks: horizon.weeks,
    theirThisWeek: theirValue.total,
    depth,
  };
}

/**
 * How full a roster is: everyone not on IR, against the starting slots plus the
 * bench. A pickup needs a free spot or a drop, and ESPN refuses the transaction
 * otherwise.
 */
function rosterSpots(settings: RosterSettings, players: readonly RosterPlayer[]) {
  const total = expandStartingSlots(settings).length + settings.benchSize;
  const used = players.filter((p) => p.currentSlot !== 'IR').length;
  return { used, total, room: Math.max(0, total - used) };
}

/** Settled rows, newest first. */
function settledFirst<T extends { status: string; at: string | null }>(rows: readonly T[]): T[] {
  return rows.filter((t) => t.status !== 'pending').sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
}

export interface ReviewView {
  /** Every finished week recorded for this league, oldest first. */
  readonly weeks: readonly WeekResults[];
}

/** The recorded weeks behind the review page; recording any missing week first. */
export function loadReview(key?: string | null): Promise<Loaded<ReviewView>> {
  return load(key, async (reader, ref, league, connKey) => ({
    weeks: await reviewWeeks(reader, ref, league, connKey),
  }));
}

export function loadSettings(key?: string | null): Promise<Loaded<SettingsView>> {
  return load(key, async (_reader, _ref, league) => {
    const items = ((league.scoringRaw as any)?.scoringItems ?? []) as any[];
    const parsed = parseEspnScoring(items);

    const scoring: ScoringRow[] = items
      .filter((i) => i.points !== 0 || Object.keys(i.pointsOverrides ?? {}).length > 0)
      .map((i) => ({
        statId: i.statId,
        points: i.points,
        // ESPN sends an empty object for rules with no overrides; treat that as none.
        overrides: i.pointsOverrides && Object.keys(i.pointsOverrides).length > 0
          ? Object.entries(i.pointsOverrides)
              .map(([pos, pts]) => `pos ${pos}: ${pts}`)
              .join(', ')
          : null,
      }))
      .sort((a, b) => a.statId - b.statId);

    return {
      league,
      rosterSettings: league.rosterSettings,
      scoring,
      scoredRuleCount: parsed.itemCount,
    };
  });
}
