/**
 * Betting lines from ESPN's public endpoints (DraftKings), no key.
 *
 *   Game lines:   site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard
 *                   ?seasontype=2&week={week}&dates={season}
 *                 The spread (the home team's number) and the over/under per game.
 *   Player props: sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/{id}
 *                   /competitions/{id}/odds                      → providers
 *                   /competitions/{id}/odds/{provider}/propBets  → lines per athlete
 *
 * Prop athletes carry ESPN athlete ids, the same ids ESPN fantasy uses, so they
 * match roster players directly. Verified 2026-09-15 on week 2: all 16 games had
 * lines, and one game carried 98 props.
 */

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const CORE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events';
const CACHE_TTL_MS = 30 * 60 * 1000;
/** DraftKings, which ESPN's scoreboard lines also come from. */
const PREFERRED_PROVIDER = '100';

export interface TeamOdds {
  readonly team: string;
  readonly opponent: string;
  readonly home: boolean;
  /** The team's own spread: negative when favored. */
  readonly spread: number;
  readonly total: number;
  /** Points the market expects the team to score. */
  readonly impliedPoints: number;
  readonly provider: string;
  readonly eventId: string;
}

/** Over/under lines for one player. Only the stats the blend uses are kept. */
export interface PlayerLines {
  readonly passYds?: number;
  readonly rushYds?: number;
  readonly recYds?: number;
  readonly receptions?: number;
}

export interface WeekOdds {
  readonly season: number;
  readonly week: number;
  readonly teams: ReadonlyMap<string, TeamOdds>;
  /** Keyed by ESPN athlete id. */
  readonly props: ReadonlyMap<string, PlayerLines>;
  readonly provider: string | null;
  /** Requests that failed; affected games simply have no props. */
  readonly failed: number;
  readonly fetchedAt: string;
}

/** Prop type ids ESPN uses for the lines the blend reads. */
const PROP_TYPE: Readonly<Record<string, keyof PlayerLines>> = {
  '8': 'passYds',
  '12': 'rushYds',
  '13': 'recYds',
  '14': 'receptions',
};

const round1 = (n: number) => Math.round(n * 10) / 10;

export function parseScoreboardOdds(data: unknown): TeamOdds[] {
  const out: TeamOdds[] = [];
  for (const event of ((data as { events?: unknown[] })?.events ?? []) as Record<string, any>[]) {
    const comp = event?.competitions?.[0];
    const odds = comp?.odds?.[0];
    const home = comp?.competitors?.find((c: any) => c?.homeAway === 'home')?.team?.abbreviation;
    const away = comp?.competitors?.find((c: any) => c?.homeAway === 'away')?.team?.abbreviation;
    const total = Number(odds?.overUnder);
    const spread = Number(odds?.spread);
    if (typeof home !== 'string' || typeof away !== 'string' || !Number.isFinite(total) || !Number.isFinite(spread)) {
      continue;
    }
    const provider = String(odds?.provider?.name ?? 'Sportsbook');
    const eventId = String(event.id);
    // `spread` is the home team's number: -4.5 means home is favored by 4.5.
    out.push(
      { team: home, opponent: away, home: true, spread, total, impliedPoints: round1((total - spread) / 2), provider, eventId },
      { team: away, opponent: home, home: false, spread: -spread, total, impliedPoints: round1((total + spread) / 2), provider, eventId },
    );
  }
  return out;
}

export function parsePropBets(data: unknown): Map<string, PlayerLines> {
  const out = new Map<string, Record<string, number>>();
  for (const item of ((data as { items?: unknown[] })?.items ?? []) as Record<string, any>[]) {
    const key = PROP_TYPE[String(item?.type?.id)];
    const id = /athletes\/(\d+)/.exec(String(item?.athlete?.$ref ?? ''))?.[1];
    const value = Number(item?.current?.target?.value);
    if (!key || !id || !Number.isFinite(value)) continue;
    const lines = out.get(id) ?? {};
    // The first line listed is the main one; later ones are alternates.
    if (lines[key] === undefined) lines[key] = value;
    out.set(id, lines);
  }
  return out as Map<string, PlayerLines>;
}

const cache = new Map<string, { at: number; odds: Promise<WeekOdds> }>();

export function clearOddsCache(): void {
  cache.clear();
}

/**
 * Game lines and player props for a week. Cached for half an hour; concurrent
 * callers share one fetch. Throws only if the scoreboard itself cannot be read.
 */
export function fetchWeekOdds(
  season: number,
  week: number,
  opts: { fetchImpl?: typeof fetch | undefined; now?: number; concurrency?: number } = {},
): Promise<WeekOdds> {
  const key = `${season}:${week}`;
  const now = opts.now ?? Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.odds;

  const odds = load(season, week, opts).catch((error: unknown) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, { at: now, odds });
  return odds;
}

async function load(
  season: number,
  week: number,
  opts: { fetchImpl?: typeof fetch | undefined; concurrency?: number },
): Promise<WeekOdds> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const get = async (url: string): Promise<unknown> => {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`ESPN odds returned HTTP ${res.status}`);
    return res.json();
  };

  const games = parseScoreboardOdds(await get(`${SCOREBOARD}?seasontype=2&week=${week}&dates=${season}`));
  const teams = new Map(games.map((g) => [g.team, g]));
  const events = [...new Set(games.map((g) => g.eventId))];

  const props = new Map<string, PlayerLines>();
  let failed = 0;
  const queue = [...events];
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      const base = `${CORE}/${id}/competitions/${id}/odds`;
      try {
        let data: unknown;
        try {
          // DraftKings carries nearly every game, so ask it directly: one request, not two.
          data = await get(`${base}/${PREFERRED_PROVIDER}/propBets?limit=500`);
        } catch {
          const listed = ((await get(base)) as { items?: { provider?: { id?: unknown } }[] }).items ?? [];
          const other = listed.map((i) => String(i.provider?.id ?? '')).find((p) => p && p !== PREFERRED_PROVIDER);
          if (!other) throw new Error('no provider with props');
          data = await get(`${base}/${other}/propBets?limit=500`);
        }
        for (const [athlete, lines] of parsePropBets(data)) props.set(athlete, lines);
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 8, queue.length) }, worker));

  return {
    season,
    week,
    teams,
    props,
    provider: games[0]?.provider ?? null,
    failed,
    fetchedAt: new Date().toISOString(),
  };
}
