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
  openedRoleNote,
  type NewsFinding,
  type OpenedRole,
  optimizeLineup,
  rankWaiverCandidates,
  valueToRoster,
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
  readWebPicks,
  type WebPicksReport,
  describeError,
  gatherPlayerNews,
  AdapterFailure,
  parseEspnScoring,
  type LeagueInfo,
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
    marketFor(league, week),
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
}

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
    const ranked = rankWaiverCandidates(mine, pool, league.rosterSettings);
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
      candidates: ranked.slice(0, 40),
      considered: available.length,
      pickupById,
      proTeamById,
      webPicks,
      pickGains: Object.fromEntries(
        ranked.filter((c) => webPicks?.picks.some((p) => p.playerId === c.player.gsisId)).map((c) => [c.player.gsisId, c.lineupGain]),
      ),
      available: availablePlayers(available, ranked, webPicks, openings),
      openings: Object.fromEntries(openings),
    };
  });
}

/** The waiver pool as plain rows: adjusted projection and lineup gain from the ranking, status from ESPN. */
function availablePlayers(
  pool: readonly RosterPlayer[],
  ranked: readonly WaiverCandidate[],
  webPicks: WebPicksReport | null,
  openings: ReadonlyMap<string, OpenedRole>,
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
  /** The NFL opponent's defense and how it moved the projection; null when matchups are off or unknown. */
  /** What they have actually scored this season, and how it moved the projection. */
  readonly form: {
    readonly average: number;
    readonly games: number;
    readonly factor: number;
    readonly pricedByMarket: boolean;
  } | null;
  readonly matchup: {
    readonly opponent: string;
    readonly home: boolean;
    readonly allowed: number;
    readonly average: number;
    readonly rank: number;
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
              allowed: target!.matchup.allowed,
              average: target!.matchup.average,
              rank: target!.matchup.rank,
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

// ------------------------------------------------------------------- trades --

export interface TradeIdea {
  readonly opponentTeam: string;
  readonly give: string;
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
