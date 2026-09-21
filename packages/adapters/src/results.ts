/**
 * Weekly results, kept as data for training and for checking the app against
 * what actually happened.
 *
 * Two files per league and week, beside the credential store:
 *   <league>_w<week>.snapshot.json  what the app believed before kickoff, per player:
 *                                   ESPN's projection, the app's, and each adjustment
 *                                   (betting lines, matchup, form, news), with the
 *                                   recommended slot or pickup value. Written as pages
 *                                   price players; an entry stops changing once the
 *                                   player's game locks, because the lines and
 *                                   adjustments cannot be rebuilt afterwards.
 *   <league>_w<week>.results.json   once the week is over: actual points, the lineup
 *                                   that was set, and the snapshot joined to them.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './credentials.js';

export type ResultOwnerKind = 'mine' | 'team' | 'waivers' | 'free-agent';

/** One player as the app priced them for a week. */
export interface PlayerSnapshot {
  readonly id: string;
  readonly name: string;
  readonly position: string;
  readonly proTeam: string | null;
  readonly ownerKind: ResultOwnerKind;
  /** ESPN's projection. */
  readonly espn: number;
  /** The app's, with every adjustment applied. */
  readonly projected: number;
  /** The betting-line blend, when lines existed. */
  readonly market?: number;
  readonly matchupFactor?: number;
  readonly formFactor?: number;
  readonly news?: { readonly status: string; readonly factor: number };
  /** Your players: the recommended slot, "BENCH" when not starting. */
  readonly slot?: string;
  /** Pickups: points added to your best lineup this week, and across the coming weeks. */
  readonly gain?: number;
  readonly horizonGain?: number;
  readonly capturedAt: string;
  /** False when captured after the player's game locked. */
  readonly beforeKickoff: boolean;
}

export interface WeekSnapshot {
  readonly leagueKey: string;
  readonly week: number;
  readonly updatedAt: string;
  readonly players: Readonly<Record<string, PlayerSnapshot>>;
}

export interface PlayerResult {
  readonly id: string;
  readonly name: string;
  readonly position: string;
  readonly proTeam: string | null;
  readonly ownerKind: ResultOwnerKind;
  /** ESPN's projection for the week, as ESPN still reports it afterwards. */
  readonly espn: number;
  /** Points actually scored under the league's rules; null when the player did not play. */
  readonly actual: number | null;
  /** Rostered players: the slot they were in for the week. */
  readonly setSlot?: string;
  /** What the app believed before kickoff, when it priced this player. */
  readonly app?: PlayerSnapshot;
  /** The news check's finding for the player that week, and whether it was in use. */
  readonly news?: { readonly status: string; readonly factor: number; readonly summary: string; readonly used: boolean };
  /** Named in the week's web waiver picks. */
  readonly webPick?: boolean;
}

export interface WeekResults {
  readonly leagueKey: string;
  readonly week: number;
  readonly recordedAt: string;
  /** Whether a pre-game snapshot existed; weeks before recording began have ESPN's projections only. */
  readonly snapshotted: boolean;
  readonly lineup: {
    /** Points your set lineup scored. */
    readonly set: number;
    /** What the recommended lineup would have scored: the app's, or ESPN's best by projection without a snapshot. */
    readonly recommended: number;
    readonly recommendedFrom: 'app' | 'espn';
    /** The best lineup your roster could have fielded, in hindsight. */
    readonly best: number;
  } | null;
  readonly players: readonly PlayerResult[];
}

function defaultDir(): string {
  return join(dataDir(), 'results');
}

function fileFor(leagueKey: string, week: number, kind: 'snapshot' | 'results', dir: string): string {
  return join(dir, `${leagueKey.replace(/[^a-zA-Z0-9_-]+/g, '_')}_w${week}.${kind}.json`);
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    // A corrupt file reads as missing, and is rebuilt.
    return null;
  }
}

function writeJson(path: string, value: unknown, dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(value), 'utf8');
}

export function readSnapshot(leagueKey: string, week: number, dir: string = defaultDir()): WeekSnapshot | null {
  const s = readJson<WeekSnapshot>(fileFor(leagueKey, week, 'snapshot', dir));
  return s && typeof s.players === 'object' && s.players !== null ? s : null;
}

export function writeSnapshot(snapshot: WeekSnapshot, dir: string = defaultDir()): void {
  writeJson(fileFor(snapshot.leagueKey, snapshot.week, 'snapshot', dir), snapshot, dir);
}

/**
 * New rows merged into a week's snapshot. A row updates a player's entry field
 * by field, except that an entry taken before kickoff is never replaced by one
 * taken after the game locked.
 */
export function mergeSnapshot(
  existing: WeekSnapshot | null,
  leagueKey: string,
  week: number,
  incoming: readonly PlayerSnapshot[],
  now: string = new Date().toISOString(),
): WeekSnapshot {
  const players: Record<string, PlayerSnapshot> = { ...(existing?.players ?? {}) };
  for (const p of incoming) {
    const prev = players[p.id];
    if (prev?.beforeKickoff && !p.beforeKickoff) continue;
    players[p.id] = prev ? { ...prev, ...p } : p;
  }
  return { leagueKey, week, updatedAt: now, players };
}

export function readWeekResults(leagueKey: string, week: number, dir: string = defaultDir()): WeekResults | null {
  const r = readJson<WeekResults>(fileFor(leagueKey, week, 'results', dir));
  return r && Array.isArray(r.players) ? r : null;
}

export function writeWeekResults(results: WeekResults, dir: string = defaultDir()): void {
  writeJson(fileFor(results.leagueKey, results.week, 'results', dir), results, dir);
}

/** Every recorded week, by league and then week, for export. */
export function listWeekResults(dir: string = defaultDir()): WeekResults[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.results.json'))
    .flatMap((f) => {
      const r = readJson<WeekResults>(join(dir, f));
      return r && Array.isArray(r.players) ? [r] : [];
    })
    .sort((a, b) => a.leagueKey.localeCompare(b.leagueKey) || a.week - b.week);
}
