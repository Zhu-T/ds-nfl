/**
 * Player news from ESPN's fantasy news feed.
 *
 *   GET https://site.api.espn.com/apis/fantasy/v2/games/ffl/news/players
 *       ?limit=3&playerId=<espn player id>
 *
 * Returns the short fantasy blurbs ESPN shows on player cards: a one-sentence
 * headline and a paragraph of analysis, with a publish time. It needs no
 * cookies. Verified live on 2026-09-14.
 *
 * The same feed also carries general articles ("Story") and videos ("Media")
 * that merely mention the player. Only the player blurbs ("Rotowire") are kept:
 * a "top 10 scorers of the week" column listed under five different players is
 * noise on the page and, worse, reads to the assistant as news about each one.
 *
 * News supports the recommendations; it is not a dependency of them. If a
 * request fails, that player has no news listed and the failure is reported
 * alongside the results — never replaced with anything invented.
 */

const NEWS_URL = 'https://site.api.espn.com/apis/fantasy/v2/games/ffl/news/players';
const CACHE_TTL_MS = 10 * 60 * 1000;
const DAY_MS = 86_400_000;

export interface NewsItem {
  readonly id: string;
  readonly playerId: string;
  readonly headline: string;
  /** Plain text; ESPN's markup is stripped. */
  readonly story: string;
  /** ISO timestamp. */
  readonly published: string;
}

export interface NewsResult {
  readonly byPlayer: ReadonlyMap<string, readonly NewsItem[]>;
  /** Player ids whose news could not be fetched. */
  readonly failed: readonly string[];
}

interface FeedItem {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly playerId?: unknown;
  readonly headline?: unknown;
  readonly story?: unknown;
  readonly description?: unknown;
  readonly published?: unknown;
}

/** News changes slowly; one lookup per player per ten minutes is plenty. */
const cache = new Map<string, { at: number; items: NewsItem[] }>();

export function clearNewsCache(): void {
  cache.clear();
}

export async function fetchPlayerNews(
  playerId: string,
  opts: { limit?: number; fetchImpl?: typeof fetch | undefined; now?: number | undefined } = {},
): Promise<NewsItem[]> {
  const now = opts.now ?? Date.now();
  const hit = cache.get(playerId);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.items;

  const fetchImpl = opts.fetchImpl ?? fetch;
  // Ask for more than will be shown: articles are filtered out after the fetch.
  const url = `${NEWS_URL}?limit=${opts.limit ?? 10}&playerId=${encodeURIComponent(playerId)}`;
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`ESPN news returned HTTP ${res.status} for player ${playerId}`);

  const data = (await res.json()) as { feed?: FeedItem[] };
  const items = (data.feed ?? []).flatMap((f) => toItem(f, playerId));
  cache.set(playerId, { at: now, items });
  return items;
}

/**
 * Recent news for many players, a few requests at a time.
 *
 * Only items from the last `maxAgeDays` are kept; stale news is exactly the
 * kind of thing that would mislead the assistant into flagging a problem that
 * was resolved weeks ago.
 */
export async function fetchNewsFor(
  playerIds: readonly string[],
  opts: {
    perPlayer?: number;
    maxAgeDays?: number;
    concurrency?: number;
    fetchImpl?: typeof fetch | undefined;
    now?: number;
  } = {},
): Promise<NewsResult> {
  const now = opts.now ?? Date.now();
  const cutoff = now - (opts.maxAgeDays ?? 7) * DAY_MS;
  const byPlayer = new Map<string, NewsItem[]>();
  const failed: string[] = [];
  const queue = [...new Set(playerIds)];

  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      try {
        const items = (await fetchPlayerNews(id, { fetchImpl: opts.fetchImpl, now }))
          .filter((n) => Date.parse(n.published) >= cutoff)
          .slice(0, opts.perPlayer ?? 2);
        if (items.length > 0) byPlayer.set(id, items);
      } catch {
        failed.push(id);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 5, queue.length) }, worker));
  return { byPlayer, failed };
}

function toItem(f: FeedItem, fallbackPlayerId: string): NewsItem[] {
  if (f.type !== 'Rotowire') return [];
  const headline = clean(f.headline);
  if (!headline) return [];
  return [
    {
      id: String(f.id ?? `${fallbackPlayerId}:${String(f.published ?? '')}`),
      playerId: String(f.playerId ?? fallbackPlayerId),
      headline,
      story: clean(f.story ?? f.description),
      published: typeof f.published === 'string' ? f.published : '',
    },
  ];
}

function clean(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
