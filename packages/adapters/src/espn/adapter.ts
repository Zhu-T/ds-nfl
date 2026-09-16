import type { LineupSlot, Position } from '@ds-nfl/core';
import {
  AdapterFailure,
  type Capabilities,
  type FantasyTeam,
  type LeagueInfo,
  type LeagueReader,
  type LeagueRef,
  type Matchup,
  type RosterPlayer,
  type TeamRoster,
} from '../types.js';
import {
  PRO_TEAM_BY_ID,
  availabilityFromInjury,
  positionFromId,
  rosterSettingsFromSlotCounts,
  slotFromId,
} from './ids.js';
import { parseEspnScoring, pprLabelFromRules, type EspnScoringItem } from './scoring.js';
import { parsePositionalRatings, parseProSchedule, type PositionRatings, type ProSchedule } from './matchups.js';

const READ_HOST = 'https://lm-api-reads.fantasy.espn.com';

/**
 * League settings and the current week, shared across page loads for a minute:
 * every page needs them first, and they change weekly at most.
 */
const LEAGUE_TTL_MS = 60_000;
const leagueCache = new Map<string, { at: number; info: Promise<LeagueInfo> }>();

export function clearLeagueCache(): void {
  leagueCache.clear();
}

/** The NFL schedule, shared for twelve hours: it changes only when a game is moved. */
const SCHEDULE_TTL_MS = 12 * 60 * 60 * 1000;
const scheduleCache = new Map<number, { at: number; schedule: Promise<ProSchedule> }>();

export function clearScheduleCache(): void {
  scheduleCache.clear();
}

export interface EspnCredentials {
  readonly espnS2: string;
  readonly swid: string;
}

/**
 * ESPN reads.
 *
 * Everything here is plain HTTP with two cookies. A browser is only needed to
 * obtain those cookies in the first place (ESPN's login is a Disney OAuth flow
 * behind a bot wall) — never for reading, and not for lineup writes either;
 * see writer.ts.
 */
export class EspnReader implements LeagueReader {
  readonly platform = 'espn' as const;

  readonly capabilities: Capabilities = {
    league: { supported: true, mechanism: 'undocumented-api', confidence: 'reverse-engineered' },
    rosters: { supported: true, mechanism: 'undocumented-api', confidence: 'reverse-engineered' },
    matchups: { supported: true, mechanism: 'undocumented-api', confidence: 'reverse-engineered' },
    transactions: {
      supported: true,
      mechanism: 'undocumented-api',
      confidence: 'reverse-engineered',
    },
    freeAgents: { supported: true, mechanism: 'undocumented-api', confidence: 'reverse-engineered' },
    projections: {
      supported: true,
      mechanism: 'undocumented-api',
      confidence: 'reverse-engineered',
    },
    // Lineup changes go to ESPN's transactions endpoint as plain HTTP with the
    // read cookies, and are only reported done after the roster is read back.
    setLineup: { supported: true, mechanism: 'undocumented-api', confidence: 'reverse-engineered' },
    addDrop: { supported: false, reason: 'Adding and dropping players is not implemented yet' },
    proposeTrade: { supported: false, reason: 'Proposing trades is not implemented yet' },
  };

  /** Reads already made through this reader, by URL; see `get`. */
  private readonly memo = new Map<string, Promise<Record<string, unknown>>>();

  constructor(private readonly creds: EspnCredentials) {}

  /**
   * One league read. Through the same reader (one page load) a URL is fetched
   * once: the opponent's roster for a week comes out of the same mRoster
   * response as yours. `fresh` skips that, for the readback after a write.
   */
  private get(
    ref: LeagueRef,
    views: string[],
    week?: number,
    fresh = false,
  ): Promise<Record<string, unknown>> {
    // Without scoringPeriodId ESPN answers for the current week: that week's
    // lineup slots, and projections for it alone. Planning ahead needs it.
    const query = [
      ...views.map((v) => `view=${encodeURIComponent(v)}`),
      ...(week !== undefined ? [`scoringPeriodId=${week}`] : []),
    ].join('&');
    const url = `${READ_HOST}/apis/v3/games/ffl/seasons/${ref.season}/segments/0/leagues/${ref.leagueId}?${query}`;

    if (!fresh) {
      const hit = this.memo.get(url);
      if (hit) return hit;
    }
    const pending = this.request(ref, url);
    this.memo.set(url, pending);
    pending.catch(() => this.memo.delete(url));
    return pending;
  }

  private async request(ref: LeagueRef, url: string): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Cookie: `espn_s2=${this.creds.espnS2}; SWID=${this.creds.swid}`,
          'User-Agent': 'Mozilla/5.0',
          Accept: 'application/json',
        },
        // Caching is the caller's concern, not the adapter's: the pages that
        // use this declare `dynamic = 'force-dynamic'`, which makes Next's
        // patched fetch no-store by default.
      });
    } catch (cause) {
      throw new AdapterFailure({
        kind: 'network',
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }

    if (res.status === 401 || res.status === 403) {
      throw new AdapterFailure({
        kind: 'auth-required',
        platform: 'espn',
        hint: 'Sign in to ESPN again and paste fresh espn_s2 and SWID cookies on the Connect page.',
      });
    }
    if (res.status === 404) {
      throw new AdapterFailure({
        kind: 'not-found',
        what: `ESPN league ${ref.leagueId} for ${ref.season}`,
        hint: 'Check the league id and season. A private league also 404s when the cookies do not belong to a member.',
      });
    }
    if (!res.ok) {
      throw new AdapterFailure({
        kind: 'upstream',
        status: res.status,
        url,
        body: await res.text().catch(() => ''),
      });
    }

    const body = (await res.json()) as Record<string, unknown>;
    if (typeof body !== 'object' || body === null) {
      throw new AdapterFailure({ kind: 'shape-changed', expected: 'a JSON object', url });
    }
    return body;
  }

  private async getFiltered(ref: LeagueRef, view: string, filter: unknown, week?: number): Promise<any> {
    const period = week !== undefined ? `&scoringPeriodId=${week}` : '';
    const url = `${READ_HOST}/apis/v3/games/ffl/seasons/${ref.season}/segments/0/leagues/${ref.leagueId}?view=${view}${period}`;
    const res = await fetch(url, {
      headers: {
        Cookie: `espn_s2=${this.creds.espnS2}; SWID=${this.creds.swid}`,
        'x-fantasy-filter': JSON.stringify(filter),
        'User-Agent': 'Mozilla/5.0',
        Accept: 'application/json',
      },
    }).catch((cause) => {
      throw new AdapterFailure({ kind: 'network', message: String(cause) });
    });
    if (!res.ok) {
      throw new AdapterFailure({
        kind: 'upstream',
        status: res.status,
        url,
        body: await res.text().catch(() => ''),
      });
    }
    return res.json();
  }

  /** Players available to add, richest first by ownership. */
  async getFreeAgents(
    ref: LeagueRef,
    week: number,
    limit = 150,
    sortBy: 'owned' | 'projected' = 'owned',
  ): Promise<RosterPlayer[]> {
    const filter = {
      players: {
        filterStatus: { value: ['FREEAGENT', 'WAIVERS'] },
        limit,
        // ESPN sorts by a stat total named by its stats entry id: source 1
        // (projection), split 1 (one week), then season and week, e.g. "1120263".
        ...(sortBy === 'projected'
          ? { sortAppliedStatTotal: { sortAsc: false, sortPriority: 1, value: `11${ref.season}${week}` } }
          : { sortPercOwned: { sortAsc: false, sortPriority: 1 } }),
      },
    };
    const data = await this.getFiltered(ref, 'kona_player_info', filter, week);
    return this.fromKona(data, week, ref.season);
  }

  /**
   * The players worth evaluating as pickups for a week: the best projected for
   * that week, plus the most rostered.
   *
   * Ownership alone misses low-owned players with a real role that week. In
   * week 3 of 2026 a 15-point QB, seven kickers, and a defense sat outside the
   * top 120 by ownership, while 15 players inside it were projected for nothing.
   * The most-rostered are kept so popular stashes are still weighed.
   */
  async getFreeAgentPool(
    ref: LeagueRef,
    week: number,
    opts: { byProjection?: number; byOwnership?: number } = {},
  ): Promise<RosterPlayer[]> {
    const [projected, owned] = await Promise.all([
      this.getFreeAgents(ref, week, opts.byProjection ?? 150, 'projected'),
      this.getFreeAgents(ref, week, opts.byOwnership ?? 50, 'owned'),
    ]);
    const seen = new Set<string>();
    const pool: RosterPlayer[] = [];
    for (const p of [...projected, ...owned]) {
      if (seen.has(p.platformPlayerId)) continue;
      seen.add(p.platformPlayerId);
      pool.push(p);
    }
    return pool;
  }

  /**
   * Specific players by ESPN id, with where they are in this league: on a
   * fantasy roster, a free agent, or on waivers.
   */
  async getPlayersByIds(ref: LeagueRef, week: number, ids: readonly string[]): Promise<RosterPlayer[]> {
    if (ids.length === 0) return [];
    const filter = { players: { filterIds: { value: ids.map(Number) } } };
    const data = await this.getFiltered(ref, 'kona_player_info', filter, week);
    return this.fromKona(data, week, ref.season);
  }

  /**
   * Players whose name matches, anywhere in the league: rostered, free agent,
   * or on waivers, most rostered first. ESPN matches the start of a first or
   * last name, and rejects a name filter that has no sort.
   */
  async searchPlayersByName(ref: LeagueRef, week: number, name: string, limit = 10): Promise<RosterPlayer[]> {
    const value = name.trim();
    if (value.length < 2) return [];
    const filter = { players: { filterName: { value }, limit, sortPercOwned: { sortAsc: false, sortPriority: 1 } } };
    const data = await this.getFiltered(ref, 'kona_player_info', filter, week);
    return this.fromKona(data, week, ref.season);
  }

  /** Points each NFL defense allows to each position this season, under this league's scoring. */
  async getPositionalRatings(ref: LeagueRef, week: number): Promise<Map<Position, PositionRatings>> {
    return parsePositionalRatings(await this.get(ref, ['mPositionalRatings'], week));
  }

  /** Who plays whom each week of the season. */
  getProSchedule(ref: LeagueRef): Promise<ProSchedule> {
    const hit = scheduleCache.get(ref.season);
    if (hit && Date.now() - hit.at < SCHEDULE_TTL_MS) return hit.schedule;
    const url = `${READ_HOST}/apis/v3/games/ffl/seasons/${ref.season}?view=proTeamSchedules_wl`;
    const schedule = this.request(ref, url).then(parseProSchedule);
    scheduleCache.set(ref.season, { at: Date.now(), schedule });
    schedule.catch(() => scheduleCache.delete(ref.season));
    return schedule;
  }

  /** Players from a kona_player_info response, as roster players with their league status. */
  private fromKona(data: any, week: number, season: number): RosterPlayer[] {

    const out: RosterPlayer[] = [];
    for (const entry of (data.players ?? []) as Record<string, any>[]) {
      const p = entry.player;
      const position = positionFromId(p?.defaultPositionId);
      if (!p || !position) continue;
      const injury = availabilityFromInjury(p.injuryStatus);
      out.push({
        platformPlayerId: String(p.id),
        name: String(p.fullName ?? 'Unknown'),
        position,
        eligibleSlots: ((p.eligibleSlots ?? []) as number[])
          .map(slotFromId)
          .filter((x): x is LineupSlot => x !== null),
        currentSlot: 'BENCH',
        projectedPoints: weeklyProjection(p.stats, week), ...projectionDetail(p.stats, week, p.defaultPositionId),
        available: injury.available,
        ...(injury.reason ? { unavailableReason: injury.reason } : {}),
        proTeam: PRO_TEAM_BY_ID[p.proTeamId as number] ?? null,
        ...(typeof p.lastNewsDate === 'number' ? { lastNewsAt: p.lastNewsDate } : {}), ...(typeof p.ownership?.percentOwned === 'number' ? { percentOwned: p.ownership.percentOwned } : {}), ...seasonForm(p.stats, season),
        locked: Boolean(entry.lineupLocked),
        ...(entry.status === 'WAIVERS'
          ? { pickup: 'waivers' as const }
          : entry.status === 'FREEAGENT'
            ? { pickup: 'free-agent' as const }
            : {}),
        ...(entry.status === 'ONTEAM' && entry.onTeamId !== undefined ? { onTeamId: String(entry.onTeamId) } : {}),
      });
    }
    return out;
  }

  /** Every team's roster, for trade evaluation. */
  async getAllRosters(ref: LeagueRef, week: number): Promise<Map<string, RosterPlayer[]>> {
    const data = await this.get(ref, ['mRoster'], week);
    const season = ref.season;
    const out = new Map<string, RosterPlayer[]>();
    for (const team of (data['teams'] ?? []) as Record<string, any>[]) {
      const players: RosterPlayer[] = [];
      for (const entry of (team.roster?.entries ?? []) as Record<string, any>[]) {
        const p = entry.playerPoolEntry?.player;
        const position = positionFromId(p?.defaultPositionId);
        const currentSlot = slotFromId(entry.lineupSlotId);
        if (!p || !position || !currentSlot) continue;
        const injury = availabilityFromInjury(p.injuryStatus);
        players.push({
          platformPlayerId: String(p.id),
          name: String(p.fullName ?? 'Unknown'),
          position,
          eligibleSlots: ((p.eligibleSlots ?? []) as number[])
            .map(slotFromId)
            .filter((x): x is LineupSlot => x !== null),
          currentSlot,
          projectedPoints: weeklyProjection(p.stats, week), ...projectionDetail(p.stats, week, p.defaultPositionId),
          available: injury.available && currentSlot !== 'IR',
          ...(injury.reason ? { unavailableReason: injury.reason } : {}),
          proTeam: PRO_TEAM_BY_ID[p.proTeamId as number] ?? null,
          ...(typeof p.lastNewsDate === 'number' ? { lastNewsAt: p.lastNewsDate } : {}), ...(typeof p.ownership?.percentOwned === 'number' ? { percentOwned: p.ownership.percentOwned } : {}), ...seasonForm(p.stats, season),
          locked: Boolean(entry.playerPoolEntry?.lineupLocked),
        });
      }
      out.set(String(team.id), players);
    }
    return out;
  }

  getLeague(ref: LeagueRef): Promise<LeagueInfo> {
    const key = `${ref.leagueId}:${ref.season}:${this.creds.swid}`;
    const hit = leagueCache.get(key);
    if (hit && Date.now() - hit.at < LEAGUE_TTL_MS) return hit.info;
    const info = this.loadLeague(ref);
    leagueCache.set(key, { at: Date.now(), info });
    info.catch(() => leagueCache.delete(key));
    return info;
  }

  private async loadLeague(ref: LeagueRef): Promise<LeagueInfo> {
    const data = await this.get(ref, ['mSettings', 'mStatus']);
    const settings = data['settings'] as Record<string, any> | undefined;
    if (!settings?.rosterSettings?.lineupSlotCounts) {
      throw new AdapterFailure({
        kind: 'shape-changed',
        expected: 'settings.rosterSettings.lineupSlotCounts',
        url: 'mSettings',
      });
    }

    const { slots, benchSize, irSize } = rosterSettingsFromSlotCounts(
      settings.rosterSettings.lineupSlotCounts as Record<string, number>,
    );

    const scoringItems = (settings.scoringSettings?.scoringItems ?? []) as EspnScoringItem[];
    const scoring = parseEspnScoring(scoringItems);
    const teamCount = Number(settings.size ?? 0);

    return {
      leagueId: ref.leagueId,
      platform: 'espn',
      season: ref.season,
      name: String(settings.name ?? 'ESPN league'),
      teamCount,
      rosterSettings: { slots, benchSize, irSize },
      formatLabel: `${teamCount}-team · ${pprLabelFromRules(scoring)}`,
      scoringRaw: settings.scoringSettings,
      currentWeek: Number((data['scoringPeriodId'] as number) ?? 1),
      finalWeek: Number((data['status'] as Record<string, unknown> | undefined)?.['finalScoringPeriod'] ?? 17),
    };
  }

  async getMatchup(ref: LeagueRef, week: number): Promise<Matchup | null> {
    const data = await this.get(ref, ['mMatchupScore', 'mTeam']);
    const schedule = (data['schedule'] ?? []) as Record<string, any>[];
    const names = new Map(
      ((data['teams'] ?? []) as Record<string, any>[]).map((t) => [String(t.id), teamName(t)]),
    );

    const pairing = schedule.find(
      (m) =>
        m?.matchupPeriodId === week &&
        (String(m?.home?.teamId) === String(ref.teamId) ||
          String(m?.away?.teamId) === String(ref.teamId)),
    );
    if (!pairing) return null;

    const iAmHome = String(pairing['home']?.teamId) === String(ref.teamId);
    const me = iAmHome ? pairing['home'] : pairing['away'];
    const them = iAmHome ? pairing['away'] : pairing['home'];
    if (!me || !them) return null;

    return {
      week,
      myTeamName: names.get(String(me.teamId)) ?? 'My team',
      opponentTeamName: names.get(String(them.teamId)) ?? 'Opponent',
      opponentTeamId: String(them.teamId),
      myProjected: round1(me.totalProjectedPoints),
      opponentProjected: round1(them.totalProjectedPoints),
      myLive: round1(me.totalPoints),
      opponentLive: round1(them.totalPoints),
    };
  }

  async getTeams(ref: LeagueRef): Promise<FantasyTeam[]> {
    const data = await this.get(ref, ['mTeam']);
    const teams = (data['teams'] ?? []) as Record<string, any>[];
    return teams.map((t) => ({
      teamId: String(t.id),
      name: teamName(t),
      isMine: String(t.id) === String(ref.teamId),
      wins: t.record?.overall?.wins,
      losses: t.record?.overall?.losses,
    }));
  }

  async getRoster(ref: LeagueRef, week: number, opts: { fresh?: boolean } = {}): Promise<TeamRoster> {
    const data = await this.get(ref, ['mRoster'], week, opts.fresh);
    const season = ref.season;
    const teams = (data['teams'] ?? []) as Record<string, any>[];
    const team = teams.find((t) => String(t.id) === String(ref.teamId));

    if (!team) {
      throw new AdapterFailure({
        kind: 'not-found',
        what: `Team ${ref.teamId} in league ${ref.leagueId}`,
        hint: `The league has teams ${teams.map((t) => t.id).join(', ')}.`,
      });
    }

    const entries = (team.roster?.entries ?? []) as Record<string, any>[];
    const players: RosterPlayer[] = [];

    for (const entry of entries) {
      const p = entry.playerPoolEntry?.player;
      if (!p) continue;

      const position = positionFromId(p.defaultPositionId);
      const currentSlot = slotFromId(entry.lineupSlotId);
      // A player whose position or slot we cannot map is surfaced by omission
      // rather than guessed at; guessing here corrupts the lineup silently.
      if (!position || !currentSlot) continue;

      const eligibleSlots = ((p.eligibleSlots ?? []) as number[])
        .map(slotFromId)
        .filter((s): s is LineupSlot => s !== null);

      const injury = availabilityFromInjury(p.injuryStatus ?? entry.injuryStatus);

      players.push({
        platformPlayerId: String(p.id),
        name: String(p.fullName ?? 'Unknown'),
        position,
        eligibleSlots,
        currentSlot,
        projectedPoints: weeklyProjection(p.stats, week), ...projectionDetail(p.stats, week, p.defaultPositionId),
        locked: Boolean(entry.playerPoolEntry?.lineupLocked),
        available: injury.available && currentSlot !== 'IR',
        ...(injury.reason ? { unavailableReason: injury.reason } : {}),
        proTeam: PRO_TEAM_BY_ID[p.proTeamId as number] ?? null,
        ...(typeof p.lastNewsDate === 'number' ? { lastNewsAt: p.lastNewsDate } : {}), ...(typeof p.ownership?.percentOwned === 'number' ? { percentOwned: p.ownership.percentOwned } : {}), ...seasonForm(p.stats, season),
      });
    }

    return { teamId: ref.teamId, week, players };
  }

  /**
   * Current slot per player id.
   *
   * This is the readback a verified write compares against — the write is not
   * reported as successful until this shows the new slots.
   */
  async getSlotMap(ref: LeagueRef, week: number): Promise<Map<string, LineupSlot>> {
    // Fresh: this confirms a write, so it must not reuse the read made before it.
    const roster = await this.getRoster(ref, week, { fresh: true });
    return new Map(roster.players.map((p) => [p.platformPlayerId, p.currentSlot]));
  }
}

/**
 * ESPN's own projection for a given week, already scored under this league's
 * rules because the request was league-scoped.
 *
 *   statSourceId 1 = projection (0 = actual)
 *   statSplitTypeId 1 = single week (0 = season total)
 */
/**
 * What the player has actually scored this season: ESPN's season-to-date total
 * for this season carries the per-game average, and the two give the games
 * played. Rows for other seasons are ignored.
 */
function seasonForm(stats: unknown, season: number): { seasonAverage?: number; gamesPlayed?: number } {
  if (!Array.isArray(stats)) return {};
  const hit = stats.find(
    (s: any) => s?.statSourceId === 0 && s?.statSplitTypeId === 0 && s?.seasonId === season,
  ) as any;
  const total = hit?.appliedTotal;
  const average = hit?.appliedAverage;
  if (typeof total !== 'number' || typeof average !== 'number' || average <= 0) return {};
  return { seasonAverage: Math.round(average * 10) / 10, gamesPlayed: Math.max(1, Math.round(total / average)) };
}

function weeklyProjection(stats: unknown, week: number): number {
  if (!Array.isArray(stats)) return 0;
  const hit = stats.find(
    (s: any) => s?.statSourceId === 1 && s?.statSplitTypeId === 1 && s?.scoringPeriodId === week,
  );
  const total = (hit as any)?.appliedTotal;
  return typeof total === 'number' ? Math.round(total * 10) / 10 : 0;
}

/**
 * ESPN's projected stat line for the week and the player's position id: what
 * the betting-market blend rescores (see market.ts). Omitted when absent.
 */
function projectionDetail(
  stats: unknown,
  week: number,
  positionId: unknown,
): { projectedStats?: Record<string, number>; positionId?: number } {
  const hit = Array.isArray(stats)
    ? stats.find((s: any) => s?.statSourceId === 1 && s?.statSplitTypeId === 1 && s?.scoringPeriodId === week)
    : undefined;
  const raw = (hit as any)?.stats;
  const projectedStats: Record<string, number> = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'number') projectedStats[k] = v;
  }
  return {
    ...(Object.keys(projectedStats).length > 0 ? { projectedStats } : {}),
    ...(typeof positionId === 'number' ? { positionId } : {}),
  };
}

function round1(n: unknown): number {
  return typeof n === 'number' ? Math.round(n * 10) / 10 : 0;
}

function teamName(t: Record<string, any>): string {
  const explicit = t.name ?? t.nickname;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const combined = [t.location, t.nickname].filter(Boolean).join(' ').trim();
  return combined || `Team ${t.id}`;
}
