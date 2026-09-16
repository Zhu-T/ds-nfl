/**
 * Saved AI conversations, one file per league.
 *
 * Kept beside the credential store — data/ in development, %APPDATA%\ds-nfl in
 * the desktop app — so each league's conversation stays separate and never
 * leaves this machine.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './credentials.js';

export interface ChatMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  /** ISO time the message was written. */
  readonly at: string;
  /** Who wrote an assistant message, e.g. "deepseek-r1:14b, running locally". */
  readonly author?: string;
  /** An answer that failed the number check; it is kept out of future context. */
  readonly withheld?: boolean;
  /** For a question: the players the app looked up for it, by name. */
  readonly lookedUp?: readonly string[];
  /** For a question: the looked-up rows as the model saw them, so later answers may quote them. */
  readonly lookup?: string;
}

/** Old messages beyond this are dropped from the file. */
const MAX_STORED = 200;

function defaultDir(): string {
  return join(dataDir(), 'conversations');
}

function fileFor(leagueKey: string, dir: string): string {
  return join(dir, `${leagueKey.replace(/[^a-zA-Z0-9_-]+/g, '_')}.json`);
}

export function readConversation(leagueKey: string, dir: string = defaultDir()): ChatMessage[] {
  const path = fileFor(leagueKey, dir);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return Array.isArray(parsed) ? (parsed as ChatMessage[]) : [];
  } catch {
    // A corrupt file reads as an empty conversation rather than breaking the page.
    return [];
  }
}

export function appendToConversation(
  leagueKey: string,
  messages: readonly ChatMessage[],
  dir: string = defaultDir(),
): ChatMessage[] {
  const next = [...readConversation(leagueKey, dir), ...messages].slice(-MAX_STORED);
  mkdirSync(dir, { recursive: true });
  writeFileSync(fileFor(leagueKey, dir), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function clearConversation(leagueKey: string, dir: string = defaultDir()): void {
  rmSync(fileFor(leagueKey, dir), { force: true });
}
