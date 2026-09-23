/**
 * Players you have marked as protected: never suggested as a drop, and refused
 * as one if something tries.
 *
 * Kept per league beside the credential store, as `<league>.protected.json`,
 * because it is your judgement rather than anything ESPN knows. Note that
 * "locked" elsewhere in the app means a player's game has started; this is a
 * separate, deliberate choice.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './credentials.js';

export interface ProtectedPlayers {
  readonly leagueKey: string;
  readonly updatedAt: string;
  /** Platform player ids. */
  readonly ids: readonly string[];
}

function defaultDir(): string {
  return dataDir();
}

function fileFor(leagueKey: string, dir: string): string {
  return join(dir, `${leagueKey.replace(/[^a-zA-Z0-9_-]+/g, '_')}.protected.json`);
}

export function readProtected(leagueKey: string, dir: string = defaultDir()): ProtectedPlayers | null {
  const path = fileFor(leagueKey, dir);
  if (!existsSync(path)) return null;
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8')) as ProtectedPlayers;
    return Array.isArray(saved?.ids) ? saved : null;
  } catch {
    // A corrupt file reads as nothing protected, rather than blocking every drop.
    return null;
  }
}

/** The protected ids for a league, as a set; empty when none are saved. */
export function protectedIds(leagueKey: string, dir: string = defaultDir()): Set<string> {
  return new Set(readProtected(leagueKey, dir)?.ids ?? []);
}

export function writeProtected(leagueKey: string, ids: readonly string[], dir: string = defaultDir()): ProtectedPlayers {
  const saved: ProtectedPlayers = {
    leagueKey,
    updatedAt: new Date().toISOString(),
    ids: [...new Set(ids)].sort(),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(fileFor(leagueKey, dir), JSON.stringify(saved), 'utf8');
  return saved;
}

/** Protect a player, or stop protecting them, and save. */
export function setProtected(leagueKey: string, playerId: string, on: boolean, dir: string = defaultDir()): ProtectedPlayers {
  const ids = protectedIds(leagueKey, dir);
  if (on) ids.add(playerId);
  else ids.delete(playerId);
  return writeProtected(leagueKey, [...ids], dir);
}
