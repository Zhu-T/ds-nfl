/**
 * Sleeper reads.
 *
 * The public API needs no credentials of any kind, which makes it the clearest
 * test of whether the adapter abstraction is real: it differs from ESPN on every
 * axis that matters. No auth, a documented and stable shape, no write path
 * whatsoever, and — importantly — no point projections.
 *
 * That last gap is declared rather than papered over. Without projections the
 * lineup optimizer has nothing to rank, so the UI must say so instead of
 * presenting an empty or arbitrary recommendation.
 *
 * https://docs.sleeper.com
 */

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

const BASE = 'https://api.sleeper.app/v1';

/** Sleeper roster_positions slot names to ours. */
const SLOT_BY_NAME: Readonly<Record<string, LineupSlot>> = {
  QB: 'QB',
  RB: 'RB',
  WR: 'WR',
  TE: 'TE',
  K: 'K',
  DEF: 'DST',
  FLEX: 'FLEX',
  REC_FLEX: 'WR_TE',
  WRRB_FLEX: 'RB_WR',
  SUPER_FLEX: 'OP',
  BN: 'BENCH',
  IR: 'IR',
  TAXI: 'IR',
};

const POSITION_BY_NAME: Readonly<Record<string, Position>> = {
  QB: 'QB',
  RB: 'RB',
  FB: 'RB',
  WR: 'WR',
  TE: 'TE',
  K: 'K',
  DEF: 'DST',
};

export class SleeperReader implements LeagueReader {
  readonly platform = 'sleeper' as const;

  readonly capabilities: Capabilities = {
    league: { supported: true, mechanism: 'public-api', confidence: 'stable' },
    rosters: { supported: true, mechanism: 'public-api', confidence: 'stable' },
    matchups: { supported: true, mechanism: 'public-api', confidence: 'stable' },
    transactions: { supported: true, mechanism: 'public-api', confidence: 'stable' },
    freeAgents: { supported: true, mechanism: 'public-api', confidence: 'stable' },
    projections: {
      supported: false,
      reason:
        'Sleeper publishes no point projections, so lineup and waiver advice needs a projection source of our own',
    },
    setLineup: { supported: false, reason: 'Sleeper has no public write API' },
    addDrop: { supported: false, reason: 'Sleeper has no public write API' },
    proposeTrade: { supported: false, reason: 'Sleeper has no public write API' },
  };

  /** Injected so tests can serve fixtures without patching global fetch. */
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async get<T>(path: string): Promise<T> {
    const url = `${BASE}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { Accept: 'application/json' } });
    } catch (cause) {
      throw new AdapterFailure({
        kind: 'network',
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }

    if (res.status === 404) {
      throw new AdapterFailure({
        kind: 'not-found',
        what: `Sleeper resource ${path}`,
        hint: 'Check the league id. Sleeper league ids are long numeric strings.',
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

    const body = (await res.json()) as T;
    if (body === null || body === undefined) {
      throw new AdapterFailure({ kind: 'shape-changed', expected: 'a JSON body', url });
    }
    return body;
  }

  async getLeague(ref: LeagueRef): Promise<LeagueInfo> {
    const league = await this.get<any>(`/league/${ref.leagueId}`);
    const state = await this.get<any>('/state/nfl');

    const positions = (league.roster_positions ?? []) as string[];
    const slots: Partial<Record<LineupSlot, number>> = {};
    let benchSize = 0;
    let irSize = 0;

    for (const name of positions) {
      const slot = SLOT_BY_NAME[name];
      if (!slot) continue; // unknown slot: ignored rather than guessed at
      if (slot === 'BENCH') benchSize++;
      else if (slot === 'IR') irSize++;
      else slots[slot] = (slots[slot] ?? 0) + 1;
    }

    const teamCount = Number(league.total_rosters ?? 0);
    const rec = Number(league.scoring_settings?.rec ?? 0);

    return {
      leagueId: ref.leagueId,
      platform: 'sleeper',
      season: Number(league.season ?? ref.season),
      name: String(league.name ?? 'Sleeper league'),
      teamCount,
      rosterSettings: { slots, benchSize, irSize },
      formatLabel: `${teamCount}-team · ${rec >= 1 ? 'Full PPR' : rec > 0 ? `${rec} PPR` : 'Standard'}`,
      scoringRaw: league.scoring_settings,
      currentWeek: Number(state.week ?? 1),
      // Sleeper does not publish the season's last scoring week directly; 18 is
      // the NFL's last week, so planning ahead never runs past the season.
      finalWeek: 18,
      // Sleeper's playoff settings are not read yet, so the season simulation stays ESPN-only.
      playoffTeamCount: 0,
      regularSeasonWeeks: 14,
      faabBudget: 0,
      waiverRun: null,
    };
  }

  async getTeams(ref: LeagueRef): Promise<FantasyTeam[]> {
    const [rosters, users] = await Promise.all([
      this.get<any[]>(`/league/${ref.leagueId}/rosters`),
      this.get<any[]>(`/league/${ref.leagueId}/users`),
    ]);
    const nameByUser = new Map(
      users.map((u) => [String(u.user_id), String(u.metadata?.team_name || u.display_name || 'Team')]),
    );

    return rosters.map((r) => ({
      teamId: String(r.roster_id),
      name: nameByUser.get(String(r.owner_id)) ?? `Team ${r.roster_id}`,
      isMine: String(r.roster_id) === String(ref.teamId),
      wins: r.settings?.wins,
      losses: r.settings?.losses,
    }));
  }

  async getRoster(ref: LeagueRef, week: number): Promise<TeamRoster> {
    const [rosters, meta] = await Promise.all([
      this.get<any[]>(`/league/${ref.leagueId}/rosters`),
      loadPlayerMeta(this.fetchImpl),
    ]);

    const roster = rosters.find((r) => String(r.roster_id) === String(ref.teamId));
    if (!roster) {
      throw new AdapterFailure({
        kind: 'not-found',
        what: `Roster ${ref.teamId} in Sleeper league ${ref.leagueId}`,
        hint: `The league has rosters ${rosters.map((r) => r.roster_id).join(', ')}.`,
      });
    }

    const starters = new Set<string>((roster.starters ?? []).filter(Boolean));
    const league = await this.getLeague(ref);
    const startingSlots = expandStarting(league.rosterSettings.slots);

    const players: RosterPlayer[] = [];
    let starterIndex = 0;

    for (const id of (roster.players ?? []) as string[]) {
      const m = meta[id];
      if (!m) continue;
      const position = POSITION_BY_NAME[String(m.position)];
      if (!position) continue;

      const isStarter = starters.has(id);
      const currentSlot: LineupSlot = isStarter
        ? (startingSlots[starterIndex++] ?? 'BENCH')
        : 'BENCH';

      const injury = String(m.injury_status ?? '');
      const out = injury === 'Out' || injury === 'IR' || injury === 'Suspended';

      players.push({
        platformPlayerId: id,
        name: String(m.full_name ?? `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim()),
        position,
        eligibleSlots: eligibleFor(m.fantasy_positions),
        currentSlot,
        // Sleeper publishes no projections; zero is the honest value, and the
        // `projections` capability tells the UI not to present advice from it.
        projectedPoints: 0,
        available: !out,
        ...(injury ? { unavailableReason: injury } : {}),
        proTeam: m.team ? String(m.team) : null,
        // Sleeper's public API does not expose per-player lock state.
        locked: false,
      });
    }

    return { teamId: ref.teamId, week, players };
  }

  async getMatchup(ref: LeagueRef, week: number): Promise<Matchup | null> {
    const [matchups, teams] = await Promise.all([
      this.get<any[]>(`/league/${ref.leagueId}/matchups/${week}`),
      this.getTeams(ref),
    ]);

    const mine = matchups.find((m) => String(m.roster_id) === String(ref.teamId));
    if (!mine || mine.matchup_id == null) return null;
    const theirs = matchups.find(
      (m) => m.matchup_id === mine.matchup_id && String(m.roster_id) !== String(ref.teamId),
    );
    if (!theirs) return null;

    const nameOf = (id: string) => teams.find((t) => t.teamId === String(id))?.name ?? 'Team';

    return {
      week,
      myTeamName: nameOf(mine.roster_id),
      opponentTeamName: nameOf(theirs.roster_id),
      opponentTeamId: String(theirs.roster_id),
      // No projections available, so projected mirrors live rather than inventing a number.
      myProjected: Number(mine.points ?? 0),
      opponentProjected: Number(theirs.points ?? 0),
      myLive: Number(mine.points ?? 0),
      opponentLive: Number(theirs.points ?? 0),
    };
  }
}

function eligibleFor(fantasyPositions: unknown): LineupSlot[] {
  const names = Array.isArray(fantasyPositions) ? (fantasyPositions as string[]) : [];
  const out = new Set<LineupSlot>();
  for (const n of names) {
    const slot = SLOT_BY_NAME[n];
    if (slot) out.add(slot);
    // Skill positions are flex-eligible in every Sleeper league that has a flex.
    if (n === 'RB' || n === 'WR' || n === 'TE') {
      out.add('FLEX');
      out.add('OP');
    }
    if (n === 'RB' || n === 'WR') out.add('RB_WR');
    if (n === 'WR' || n === 'TE') out.add('WR_TE');
    if (n === 'QB') out.add('OP');
  }
  out.add('BENCH');
  return [...out];
}

function expandStarting(slots: Partial<Record<LineupSlot, number>>): LineupSlot[] {
  // Sleeper's `starters` array is ordered to match `roster_positions`.
  const order: LineupSlot[] = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'RB_WR', 'WR_TE', 'OP', 'K', 'DST'];
  const out: LineupSlot[] = [];
  for (const slot of order) {
    for (let i = 0; i < (slots[slot] ?? 0); i++) out.push(slot);
  }
  return out;
}

/**
 * The player dictionary is ~14 MB and changes at most daily, so it is fetched
 * once per process. Sleeper's docs explicitly ask callers not to poll it.
 */
let playerMetaCache: Record<string, any> | null = null;

async function loadPlayerMeta(fetchImpl: typeof fetch): Promise<Record<string, any>> {
  if (playerMetaCache) return playerMetaCache;
  const res = await fetchImpl(`${BASE}/players/nfl`, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new AdapterFailure({
      kind: 'upstream',
      status: res.status,
      url: `${BASE}/players/nfl`,
      body: '',
    });
  }
  playerMetaCache = (await res.json()) as Record<string, any>;
  return playerMetaCache;
}
