/**
 * Which of ESPN's pending moves can still actually happen.
 *
 * ESPN's transaction log is append-only and never tidies up: cancelling a claim
 * writes a CANCELED row and **leaves the original PENDING row in place**, and a
 * claim whose drop player has since gone stays PENDING for ever. Taking the log
 * at face value shows claims that will never run — including one the user had
 * already cancelled a minute after it was made.
 *
 * So a pending row is only live when nothing later has settled the same move,
 * and when the players still make sense against the roster.
 */

import type { LeagueTransaction } from './types.js';

/** The players a move touches, so the same move can be recognised across rows. */
function signature(t: LeagueTransaction): string {
  return `${t.kind}|${[...t.adds].sort().join(',')}|${[...t.drops].sort().join(',')}`;
}

export interface LiveOptions {
  /** Player ids currently on your roster. */
  readonly onRoster: ReadonlySet<string>;
}

/**
 * Pending moves that could still happen, newest first. A move is dropped when:
 *   - a later row cancelled, executed or failed the same swap;
 *   - the player it would drop is no longer on the roster;
 *   - the player it would add is already there.
 */
export function livePendingMoves(log: readonly LeagueTransaction[], opts: LiveOptions): LeagueTransaction[] {
  const settledAt = new Map<string, string>();
  for (const t of log) {
    if (t.status === 'pending') continue;
    const key = signature(t);
    const at = t.at ?? '';
    if (!settledAt.has(key) || at > settledAt.get(key)!) settledAt.set(key, at);
  }

  return log
    .filter((t) => t.status === 'pending')
    .filter((t) => {
      const settled = settledAt.get(signature(t));
      // A settled row at or after this one closed it out.
      if (settled !== undefined && settled >= (t.at ?? '')) return false;
      return t.drops.every((id) => opts.onRoster.has(id)) && t.adds.every((id) => !opts.onRoster.has(id));
    })
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
}
