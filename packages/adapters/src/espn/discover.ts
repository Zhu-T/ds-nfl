/**
 * The football leagues an ESPN account belongs to.
 *
 *   GET https://fan.api.espn.com/apis/v2/fans/{SWID}
 *
 * The same two cookies as the league reads. `preferences` lists every fantasy
 * product the account has joined; football leagues are the entries with abbrev
 * "FFL", and each carries the team id (`entryId`) as well as the league
 * (`groups[0].groupId`). That is the reason to call it: finding the team id in
 * ESPN's URLs is the most confusing step of connecting. Verified 2026-09-14.
 *
 * The SWID is part of the URL, so it is left out of every error message.
 */

import { AdapterFailure } from '../types.js';

const FAN_URL = 'https://fan.api.espn.com/apis/v2/fans';
const SHOWN_URL = `${FAN_URL}/{SWID}`;

export interface DiscoveredLeague {
  readonly leagueId: string;
  readonly teamId: string;
  readonly season: number;
  readonly leagueName: string;
  readonly teamName: string | null;
}

interface FanEntry {
  readonly abbrev?: unknown;
  readonly entryId?: unknown;
  readonly seasonId?: unknown;
  readonly entryLocation?: unknown;
  readonly entryNickname?: unknown;
  readonly groups?: readonly { readonly groupId?: unknown; readonly groupName?: unknown }[];
}

export async function discoverEspnLeagues(
  creds: { readonly espnS2: string; readonly swid: string },
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveredLeague[]> {
  const query = 'context=fantasy&source=espncom-fantasy-lm&lang=en&section=espn&region=us&displayEvents=false&displayNow=false&displayRecs=false';
  let res: Response;
  try {
    res = await fetchImpl(`${FAN_URL}/${encodeURIComponent(creds.swid)}?${query}`, {
      headers: {
        Cookie: `espn_s2=${creds.espnS2}; SWID=${creds.swid}`,
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new AdapterFailure({ kind: 'network', message: error instanceof Error ? error.message : String(error) });
  }

  if (res.status === 401 || res.status === 403) {
    throw new AdapterFailure({
      kind: 'auth-required',
      platform: 'espn',
      hint: 'Sign in to espn.com again and copy fresh espn_s2 and SWID cookies.',
    });
  }
  if (res.status === 404) {
    throw new AdapterFailure({
      kind: 'not-found',
      what: 'That ESPN account',
      hint: 'Check the SWID cookie; it should look like {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}.',
    });
  }
  if (!res.ok) throw new AdapterFailure({ kind: 'upstream', status: res.status, url: SHOWN_URL, body: '' });

  const data = (await res.json()) as { preferences?: unknown };
  if (!Array.isArray(data.preferences)) {
    throw new AdapterFailure({ kind: 'shape-changed', expected: 'a preferences list', url: SHOWN_URL });
  }

  const found = new Map<string, DiscoveredLeague>();
  for (const pref of data.preferences as { metaData?: { entry?: FanEntry } }[]) {
    const entry = pref?.metaData?.entry;
    if (!entry || entry.abbrev !== 'FFL') continue;
    const group = entry.groups?.[0];
    const season = Number(entry.seasonId);
    if (group?.groupId === undefined || entry.entryId === undefined || !Number.isFinite(season)) continue;

    const leagueId = String(group.groupId);
    // The entry's `name` is the product ("Fantasy Football 2026"), not the team, so
    // the team name is only known when ESPN fills in location and nickname.
    const teamName = `${text(entry.entryLocation)} ${text(entry.entryNickname)}`.trim() || null;
    found.set(`${leagueId}:${season}`, {
      leagueId,
      teamId: String(entry.entryId),
      season,
      leagueName: text(group.groupName) || `League ${leagueId}`,
      teamName,
    });
  }

  return [...found.values()].sort((a, b) => b.season - a.season || a.leagueName.localeCompare(b.leagueName));
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
