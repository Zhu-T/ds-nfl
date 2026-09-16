/**
 * Recent news for the connected team's players.
 */

import 'server-only';
import { fetchNewsFor, type NewsItem, type RosterPlayer } from '@ds-nfl/adapters';
import { planLineup } from './week';

const DAY_MS = 86_400_000;

export interface NewsEntry {
  readonly player: string;
  readonly position: RosterPlayer['position'];
  readonly item: NewsItem;
}

export interface NewsView {
  readonly items: readonly NewsEntry[];
  /** How many players' news could not be fetched. */
  readonly failed: number;
}

/**
 * News for a set of players, newest first.
 *
 * ESPN marks when each player last had news, so players with nothing recent are
 * skipped without a request.
 */
export async function newsForPlayers(
  players: readonly RosterPlayer[],
  maxAgeDays = 7,
): Promise<NewsView> {
  const cutoff = Date.now() - maxAgeDays * DAY_MS;
  const candidates = players.filter((p) => p.lastNewsAt === undefined || p.lastNewsAt >= cutoff);
  const { byPlayer, failed } = await fetchNewsFor(
    candidates.map((p) => p.platformPlayerId),
    { maxAgeDays, perPlayer: 2 },
  );

  const items = candidates.flatMap((p) =>
    (byPlayer.get(p.platformPlayerId) ?? []).map((item) => ({ player: p.name, position: p.position, item })),
  );
  items.sort((a, b) => Date.parse(b.item.published) - Date.parse(a.item.published));
  return { items, failed: failed.length };
}

/** News for a league's roster (the active league by default). Null when not connected. */
export async function loadRosterNews(key?: string | null, maxAgeDays = 7): Promise<NewsView | null> {
  // The roster the page already read for this load; no second trip to ESPN.
  const plan = await planLineup(key);
  if (!plan) return null;
  return newsForPlayers(plan.roster, maxAgeDays);
}
