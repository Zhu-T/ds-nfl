/**
 * Local credential storage.
 *
 * Single-user, local-machine app: credentials live in a file the user owns,
 * never in the repo and never sent anywhere except the platform they belong to.
 * `data/` is git-ignored.
 *
 * Several leagues can be connected at once; one is active, and that is the
 * league every page shows. Secrets are never returned to the browser: the UI
 * gets `leagueSummaries()`, which carries names and ids only.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface EspnConnection {
  readonly leagueId: string;
  readonly teamId: string;
  readonly season: number;
  readonly espnS2: string;
  readonly swid: string;
}

/** One connected league. */
export interface LeagueConnection extends EspnConnection {
  readonly platform: 'espn';
  /** Names captured when the league was connected, so the switcher needs no request. */
  readonly leagueName?: string;
  readonly teamName?: string;
}

export interface SleeperConnection {
  readonly leagueId: string;
  readonly teamId: string;
  readonly season: number;
}

/**
 * Which language model writes explanations, if any. The API key lives here with
 * the league cookies: on this machine only, never returned to the browser.
 */
export interface AiSettings {
  readonly provider: 'off' | 'claude' | 'ollama';
  readonly anthropicApiKey?: string;
  readonly ollamaUrl?: string;
  readonly ollamaModel?: string;
  /**
   * Model for background judgement tasks: the news check, waiver picks, and the
   * news read on Evaluate a player. Absent means the same model as everything else.
   */
  readonly ollamaJudgmentModel?: string;
  /** Model for the League AI chat, e.g. one that reasons. Absent means the same model as everything else. */
  readonly ollamaChatModel?: string;
  /** Key for Ollama's web search API (a free ollama.com account). Optional; adds a news source. */
  readonly ollamaApiKey?: string;
}

export interface Store {
  leagues?: LeagueConnection[];
  /** Key of the league every page shows; see `leagueKey`. */
  activeLeague?: string;
  /** The single-league format written before multi-league support. Migrated on read. */
  espn?: EspnConnection;
  activePlatform?: 'espn' | 'sleeper';
  sleeper?: SleeperConnection;
  ai?: AiSettings;
}

/**
 * Stable id for a league: platform, league, and season. A new season of the
 * same ESPN league is a different league here, just as it is on ESPN, and the
 * saved AI conversation is keyed the same way.
 */
export function leagueKey(league: {
  readonly platform?: 'espn' | 'sleeper';
  readonly leagueId: string;
  readonly season: number;
}): string {
  return `${league.platform ?? 'espn'}:${league.leagueId}:${league.season}`;
}

/**
 * Locate the workspace root by walking up for the package.json that declares
 * workspaces. Callers run from different directories — Next from apps/web,
 * vitest from the repo root — so a cwd-relative path silently resolves to two
 * different files depending on who asked.
 */
function workspaceRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if ((JSON.parse(readFileSync(pkg, 'utf8')) as { workspaces?: unknown }).workspaces) {
          return dir;
        }
      } catch {
        // Unreadable package.json: keep walking.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function storePath(): string {
  return process.env['DS_NFL_CREDENTIALS'] ?? join(workspaceRoot(), 'data', 'credentials.json');
}

/** The directory holding the credential store; conversations are kept beside it. */
export function dataDir(): string {
  return dirname(storePath());
}

export function readStore(): Store {
  const path = storePath();
  if (!existsSync(path)) return {};
  try {
    return normalize(JSON.parse(readFileSync(path, 'utf8')) as Store);
  } catch {
    // A corrupt store must not take the app down; it reads as "not connected".
    return {};
  }
}

/**
 * Bring an older store up to the current shape.
 *
 * A store written before multi-league support holds one league under `espn`;
 * it becomes a one-item list with that league active. Nothing is lost, and the
 * file is rewritten in the new shape the next time anything is saved.
 */
function normalize(raw: Store): Store {
  const { espn, activePlatform: _legacyPlatform, ...rest } = raw;
  let leagues = rest.leagues ?? [];
  if (leagues.length === 0 && espn) {
    leagues = [{ platform: 'espn', ...espn }];
  }
  if (leagues.length === 0) {
    const { leagues: _none, activeLeague: _noActive, ...withoutLeagues } = rest;
    return withoutLeagues;
  }
  const keys = leagues.map(leagueKey);
  const active = rest.activeLeague && keys.includes(rest.activeLeague) ? rest.activeLeague : keys[0]!;
  return { ...rest, leagues, activeLeague: active };
}

export function writeStore(store: Store): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(normalize(store), null, 2), 'utf8');
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort; Windows ACLs do not map onto POSIX modes.
  }
}

// ------------------------------------------------------------------ leagues --

export function listLeagues(): LeagueConnection[] {
  return readStore().leagues ?? [];
}

export function activeLeague(): LeagueConnection | null {
  const store = readStore();
  const leagues = store.leagues ?? [];
  return leagues.find((l) => leagueKey(l) === store.activeLeague) ?? leagues[0] ?? null;
}

export function leagueByKey(key: string): LeagueConnection | null {
  return listLeagues().find((l) => leagueKey(l) === key) ?? null;
}

/**
 * The league a request is about: the one named, or the active one.
 *
 * Actions pass the key of the league their page showed, so a lineup applied
 * from a page rendered for league A is written to league A even if league B was
 * made active in another window since.
 */
export function resolveLeague(key?: string | null): LeagueConnection | null {
  return key ? leagueByKey(key) : activeLeague();
}

/**
 * Add a league, or update it if it is already connected, and make it active.
 *
 * ESPN cookies belong to an account, not a league, so saving fresh cookies for
 * one league also refreshes every other league signed in with the same SWID.
 * When `espn_s2` expires, the user updates it once rather than per league.
 */
export function saveLeague(league: LeagueConnection): void {
  const store = readStore();
  const key = leagueKey(league);
  const refreshed = (store.leagues ?? []).map((l) =>
    l.swid === league.swid && l.espnS2 !== league.espnS2 ? { ...l, espnS2: league.espnS2 } : l,
  );
  const at = refreshed.findIndex((l) => leagueKey(l) === key);
  const leagues = at === -1 ? [...refreshed, league] : refreshed.map((l, i) => (i === at ? league : l));
  writeStore({ ...store, leagues, activeLeague: key });
}

/** Forget a league. If it was active, the first remaining league becomes active. */
export function removeLeague(key: string): void {
  const store = readStore();
  const leagues = (store.leagues ?? []).filter((l) => leagueKey(l) !== key);
  const { activeLeague: current, ...rest } = store;
  writeStore({
    ...rest,
    leagues,
    ...(current && current !== key ? { activeLeague: current } : {}),
  });
}

/** Make a connected league the active one. False if no such league is connected. */
export function setActiveLeague(key: string): boolean {
  const store = readStore();
  if (!(store.leagues ?? []).some((l) => leagueKey(l) === key)) return false;
  writeStore({ ...store, activeLeague: key });
  return true;
}

/**
 * Record a league's display names when they are missing or have changed.
 *
 * Leagues carried over from the single-league store, or renamed on ESPN, would
 * otherwise show as "League 1662359399" in the switcher. Only the names are
 * touched: never the cookies, and never which league is active.
 */
export function rememberLeagueNames(
  key: string,
  names: { readonly leagueName?: string; readonly teamName?: string },
): void {
  const store = readStore();
  const leagues = store.leagues ?? [];
  const at = leagues.findIndex((l) => leagueKey(l) === key);
  if (at === -1) return;

  const current = leagues[at]!;
  const leagueName = names.leagueName || current.leagueName;
  const teamName = names.teamName || current.teamName;
  if (leagueName === current.leagueName && teamName === current.teamName) return;

  const updated: LeagueConnection = {
    ...current,
    ...(leagueName ? { leagueName } : {}),
    ...(teamName ? { teamName } : {}),
  };
  writeStore({ ...store, leagues: leagues.map((l, i) => (i === at ? updated : l)) });
}

/**
 * Cookies to reuse when adding another league: the active league's, since
 * that is the account the user is most likely still signed in with.
 */
export function savedEspnCookies(): { espnS2: string; swid: string } | null {
  const league = activeLeague();
  return league ? { espnS2: league.espnS2, swid: league.swid } : null;
}

/** Safe for the browser: names and ids only, never the cookies. */
export interface LeagueSummary {
  readonly key: string;
  readonly platform: 'espn';
  readonly leagueId: string;
  readonly teamId: string;
  readonly season: number;
  readonly leagueName: string;
  readonly teamName: string | null;
  readonly active: boolean;
}

export function leagueSummaries(): LeagueSummary[] {
  const store = readStore();
  return (store.leagues ?? []).map((l) => ({
    key: leagueKey(l),
    platform: l.platform,
    leagueId: l.leagueId,
    teamId: l.teamId,
    season: l.season,
    leagueName: l.leagueName ?? `League ${l.leagueId}`,
    teamName: l.teamName ?? null,
    active: leagueKey(l) === store.activeLeague,
  }));
}
