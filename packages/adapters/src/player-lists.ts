/**
 * The league's player list, saved per league and week for the League AI.
 *
 * Every rostered player and who has them, plus the unrostered players the app
 * weighs as pickups. The chat looks players up in it for each question, so the
 * brief itself can stay short. It sits beside the credential store like the
 * other saved reports; the web app rebuilds it when it goes stale.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './credentials.js';

export type ListedOwnerKind = 'mine' | 'team' | 'waivers' | 'free-agent';

export interface ListedPlayer {
  readonly id: string;
  readonly name: string;
  readonly position: string;
  readonly proTeam: string | null;
  /** "Your roster", another team's name, "Waivers", or "Free agent". */
  readonly owner: string;
  readonly ownerKind: ListedOwnerKind;
  /** This week's projection. For unrostered players, web news and betting lines are applied. */
  readonly projected: number;
  /** For unrostered players: points added to your best possible lineup. */
  readonly gain?: number;
  /** Injury designation, locked, or recommended in waiver articles. */
  readonly note?: string;
}

export interface PlayerList {
  readonly leagueKey: string;
  readonly week: number;
  /** ISO time the list was built. */
  readonly updatedAt: string;
  /** The news check and web picks it was built with; a new one of either makes it stale. */
  readonly newsSignature: string;
  readonly players: readonly ListedPlayer[];
}

function defaultDir(): string {
  return join(dataDir(), 'player-lists');
}

function prefixFor(leagueKey: string): string {
  return `${leagueKey.replace(/[^a-zA-Z0-9_-]+/g, '_')}_w`;
}

function fileFor(leagueKey: string, week: number, dir: string): string {
  return join(dir, `${prefixFor(leagueKey)}${week}.json`);
}

export function readPlayerList(leagueKey: string, week: number, dir: string = defaultDir()): PlayerList | null {
  const path = fileFor(leagueKey, week, dir);
  if (!existsSync(path)) return null;
  try {
    const list = JSON.parse(readFileSync(path, 'utf8')) as PlayerList;
    return Array.isArray(list?.players) ? list : null;
  } catch {
    // A corrupt list reads as none, and is rebuilt.
    return null;
  }
}

export function writePlayerList(list: PlayerList, dir: string = defaultDir()): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(fileFor(list.leagueKey, list.week, dir), JSON.stringify(list), 'utf8');
}

/** Drop every saved week for one league, so the next use rebuilds it. */
export function clearPlayerLists(leagueKey: string, dir: string = defaultDir()): void {
  if (!existsSync(dir)) return;
  const prefix = prefixFor(leagueKey);
  for (const file of readdirSync(dir)) {
    if (file.startsWith(prefix) && file.endsWith('.json')) rmSync(join(dir, file), { force: true });
  }
}
