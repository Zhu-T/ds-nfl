/**
 * The league's player list the League AI looks players up in.
 *
 * Saved per league and week, and reused while it is fresh: under ten minutes
 * old, and built with the news check and web picks now in effect. Otherwise it
 * is rebuilt from ESPN the next time the League AI needs it.
 */

import 'server-only';
import {
  readNewsReport,
  readPlayerList,
  readWebPicks,
  writePlayerList,
  type ListedPlayer,
  type PlayerList,
} from '@ds-nfl/adapters';
import { openedRoleNote } from '@ds-nfl/core';
import { loadPlayers, type WaiverView } from './league-data';

/** A list older than this is rebuilt the next time it is needed. */
const MAX_AGE_MS = 10 * 60 * 1000;

/** What the list's projections and notes depend on besides ESPN. */
function inputsSignature(key: string, week: number): string {
  const news = readNewsReport(key, week);
  const picks = readWebPicks(key, week);
  return `${news ? `${news.checkedAt}|${news.disabled.join(',')}` : ''}#${picks?.checkedAt ?? ''}`;
}

/**
 * The saved list while it is fresh, or a new one. `waivers` is the waiver view
 * the caller already loaded; it supplies each pickup's adjusted projection and
 * lineup gain. If ESPN cannot be read, a stale list is better than none.
 */
export async function playerListFor(key: string, week: number, waivers: WaiverView | null): Promise<PlayerList | null> {
  const signature = inputsSignature(key, week);
  const saved = readPlayerList(key, week);
  if (saved && saved.newsSignature === signature && Date.now() - Date.parse(saved.updatedAt) < MAX_AGE_MS) {
    return saved;
  }

  const res = await loadPlayers(key, week);
  if (res.state !== 'ok') return saved;

  const pickups = new Map((waivers?.available ?? []).map((p) => [p.id, p]));
  const players: ListedPlayer[] = res.data.rows.map((r) => {
    const pickup = pickups.get(r.id);
    const opening = waivers?.openings[r.id];
    const note = [
      r.note ?? pickup?.injury,
      pickup?.webPick ? 'recommended in waiver articles' : null,
      opening ? `role may grow: ${openedRoleNote(opening, r.position)}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    return {
      id: r.id,
      name: r.name,
      position: r.position,
      proTeam: r.proTeam,
      owner: r.owner,
      ownerKind: r.ownerKind,
      projected: pickup?.projected ?? r.projected,
      ...(pickup ? { gain: pickup.gain } : {}),
      ...(note ? { note } : {}),
    };
  });

  const list: PlayerList = { leagueKey: key, week, updatedAt: new Date().toISOString(), newsSignature: signature, players };
  writePlayerList(list);
  return list;
}
