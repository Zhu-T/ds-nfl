/**
 * The platform contract.
 *
 * Two ideas do the work here. Capabilities are *data*, so the UI can disable an
 * action truthfully instead of failing at click time — Sleeper has no write path
 * at all, and ESPN's writes are split between an undocumented endpoint and
 * browser automation. And every failure is an explicit error: an adapter that
 * cannot authenticate throws. It never substitutes plausible data.
 *
 * That last rule is not stylistic. The previous version of this project returned
 * a hardcoded roster whenever ESPN auth failed, and those fabricated players
 * flowed into recommendations that were then acted on.
 */

import type { LineupSlot, Position, RosterSettings } from '@ds-nfl/core';

export type PlatformId = 'espn' | 'sleeper';

/** How a capability is delivered, which determines how much to trust it. */
export type WriteMechanism = 'public-api' | 'undocumented-api' | 'browser';

export type Capability =
  | { supported: false; reason: string }
  | {
      supported: true;
      mechanism: WriteMechanism;
      /** 'stable' is documented and supported; the rest can break without notice. */
      confidence: 'stable' | 'reverse-engineered' | 'dom-scraping';
    };

export interface Capabilities {
  readonly league: Capability;
  readonly rosters: Capability;
  readonly matchups: Capability;
  readonly transactions: Capability;
  readonly freeAgents: Capability;
  /**
   * Whether the platform supplies per-week point projections.
   *
   * Without these the lineup optimizer has nothing to rank, so this is not a
   * cosmetic flag — it decides whether the core feature works at all. ESPN
   * supplies them; Sleeper's public API does not.
   */
  readonly projections: Capability;
  readonly setLineup: Capability;
  readonly addDrop: Capability;
  readonly proposeTrade: Capability;
}

export interface LeagueRef {
  readonly platform: PlatformId;
  readonly leagueId: string;
  readonly season: number;
  /** The team this user controls. */
  readonly teamId: string;
}

export type AdapterError =
  | { kind: 'auth-required'; platform: PlatformId; hint: string }
  | { kind: 'not-found'; what: string; hint: string }
  | { kind: 'not-supported'; capability: keyof Capabilities; reason: string }
  | { kind: 'upstream'; status: number; url: string; body: string }
  | { kind: 'shape-changed'; expected: string; url: string }
  | { kind: 'network'; message: string };

export class AdapterFailure extends Error {
  constructor(readonly error: AdapterError) {
    super(describeError(error));
    this.name = 'AdapterFailure';
  }
}

/** Human-facing text. Says what happened and what to do, never just "failed". */
export function describeError(e: AdapterError): string {
  switch (e.kind) {
    case 'auth-required':
      return `${e.platform} rejected the saved credentials. ${e.hint}`;
    case 'not-found':
      return `${e.what} was not found. ${e.hint}`;
    case 'not-supported':
      return `${e.capability} is not supported here: ${e.reason}`;
    case 'upstream':
      return `${e.url} returned HTTP ${e.status}. ${e.body.slice(0, 160)}`;
    case 'shape-changed':
      return `${e.url} did not return ${e.expected}. The platform likely changed its response shape.`;
    case 'network':
      return `Could not reach the platform: ${e.message}`;
  }
}

// ---------------------------------------------------------------- entities --

export interface LeagueInfo {
  readonly leagueId: string;
  readonly platform: PlatformId;
  readonly season: number;
  readonly name: string;
  readonly teamCount: number;
  readonly rosterSettings: RosterSettings;
  /** Plain-language scoring summary, e.g. "12-team · Full PPR". */
  readonly formatLabel: string;
  /** Raw scoring rules kept for the engine; shape is platform-specific. */
  readonly scoringRaw: unknown;
  readonly currentWeek: number;
  /** The last scoring period of the season, playoffs included. */
  readonly finalWeek: number;
  /** How many teams reach the playoffs; 0 when the league does not say. */
  readonly playoffTeamCount: number;
  /** The last week of the regular season: after it, seeding is settled. */
  readonly regularSeasonWeeks: number;
  /** The FAAB budget each team starts with; 0 when the league uses waiver order instead. */
  readonly faabBudget: number;
  /** When the platform settles claims: the days it runs and the hour, in the league's own time. */
  readonly waiverRun: { readonly days: readonly string[]; readonly hour: number } | null;
}

export interface FantasyTeam {
  readonly teamId: string;
  readonly name: string;
  readonly isMine: boolean;
  readonly wins?: number;
  readonly losses?: number;
  readonly ties?: number;
  /** Points scored so far: ESPN's usual tiebreak for seeding. */
  readonly pointsFor?: number;
  /** FAAB spent so far, in leagues with a budget. */
  readonly faabSpent?: number;
}

export type { SeasonMatchup } from '@ds-nfl/core';

export interface RosterPlayer {
  readonly platformPlayerId: string;
  readonly name: string;
  readonly position: Position;
  /** Platform-declared eligibility. Never inferred from position. */
  readonly eligibleSlots: readonly LineupSlot[];
  /** The slot this player currently occupies on the platform. */
  readonly currentSlot: LineupSlot;
  /** Projected points for the requested week, under this league's scoring. */
  readonly projectedPoints: number;
  readonly available: boolean;
  readonly unavailableReason?: string;
  readonly proTeam: string | null;
  /**
   * True once the player's game has kicked off. The platform rejects any move
   * involving them, so they must be pinned rather than optimized around.
   */
  readonly locked: boolean;
  /**
   * For players on no roster: whether they can be added immediately or need a
   * waiver claim that processes later. Absent for rostered players. Early in a
   * season nearly everyone unrostered is on waivers, so calling them all
   * "available" promises an instant add that ESPN will not allow.
   */
  readonly pickup?: 'free-agent' | 'waivers';
  /** For a player found by a league-wide search who is on a fantasy roster: that team's id. */
  readonly onTeamId?: string;
  /** When ESPN last published news on this player (epoch ms), if known. */
  readonly lastNewsAt?: number;
  /** Percent of ESPN leagues that roster the player: who an NFL team leans on. */
  readonly percentOwned?: number;
  /**
   * ESPN's rostered +/-: the change in percentOwned, in percentage points. Managers
   * adding a player across thousands of leagues is an early sign of a streamer,
   * before projections or a defense's few games catch up.
   */
  readonly percentChange?: number;
  /** Fantasy points per game actually scored this season, under this league's scoring. */
  readonly seasonAverage?: number;
  /** Games played this season. */
  readonly gamesPlayed?: number;
  /** Points actually scored in the requested week, under the league's rules; absent before the game. */
  readonly actualPoints?: number;
  /** ESPN's projection per game for the rest of this season, and the games it covers. */
  readonly restOfSeasonAverage?: number;
  readonly restOfSeasonGames?: number;
  /** ESPN's projected stat line for the week (stat id → value), when ESPN published one. */
  readonly projectedStats?: Readonly<Record<string, number>>;
  /** ESPN's defaultPositionId, the id space its scoring overrides are keyed by. */
  readonly positionId?: number;
}

export interface TeamRoster {
  readonly teamId: string;
  readonly week: number;
  readonly players: readonly RosterPlayer[];
}

/**
 * A move on the league's transaction log: yours or another team's, settled or
 * not. A pending one changes nothing until the platform settles it, so anything
 * asking "what will my team be" has to account for these separately.
 */
export interface LeagueTransaction {
  readonly id: string;
  /** The team that proposed it; for a trade offered to you, that is the other manager. */
  readonly teamId: string;
  /** True when you proposed it. */
  readonly isMine: boolean;
  /** True when it moves a player to or from your roster, however proposed it. */
  readonly involvesMe: boolean;
  /** For a trade: the team on the other side of yours. */
  readonly otherTeamId?: string;
  /** "lineup" is a slot change; the rest move players between teams and the pool. */
  readonly kind: 'waivers' | 'free-agent' | 'trade' | 'lineup' | 'other';
  readonly status: 'pending' | 'executed' | 'canceled' | 'failed';
  /** ESPN's reason when a claim failed, e.g. "INVALIDPLAYERSOURCE". */
  readonly failure?: string;
  readonly week: number;
  readonly at: string | null;
  /** The FAAB bid, in leagues with a budget. */
  readonly bid?: number;
  /** Platform player ids coming to your roster and leaving it. */
  readonly adds: readonly string[];
  readonly drops: readonly string[];
}

export interface Matchup {
  readonly week: number;
  readonly myTeamName: string;
  readonly opponentTeamName: string;
  readonly opponentTeamId: string;
  /** Projected totals for the lineups as currently set on the platform. */
  readonly myProjected: number;
  readonly opponentProjected: number;
  /** Points actually scored so far; zero before kickoff. */
  readonly myLive: number;
  readonly opponentLive: number;
}

export interface LeagueReader {
  readonly platform: PlatformId;
  readonly capabilities: Capabilities;
  getLeague(ref: LeagueRef): Promise<LeagueInfo>;
  getTeams(ref: LeagueRef): Promise<FantasyTeam[]>;
  getRoster(ref: LeagueRef, week: number): Promise<TeamRoster>;
  /** Null when the league has no matchup for this week (bye, offseason). */
  getMatchup(ref: LeagueRef, week: number): Promise<Matchup | null>;
}
