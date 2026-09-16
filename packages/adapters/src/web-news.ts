/**
 * News gathered by the app, for a model that cannot search the web itself.
 *
 * Free sources, no keys:
 *   - ESPN's fantasy news feed: the short player blurbs ESPN shows on player
 *     cards (see espn/news.ts);
 *   - Google News search as RSS: recent headlines naming the player, from team
 *     sites, national outlets, and local papers.
 *
 * And one optional source:
 *   - Ollama's web search API, with a key from a free ollama.com account: page
 *     text for a search per player, not just headlines.
 *
 * Only player names leave the machine. What a local model reads is short and
 * attributable, and every item keeps the player it was gathered for, so a
 * finding can be checked against its own player's news.
 */

import { fetchNewsFor } from './espn/news.js';

const GOOGLE_NEWS_RSS = 'https://news.google.com/rss/search';
const OLLAMA_WEB_SEARCH = 'https://ollama.com/api/web_search';
const DAY_MS = 86_400_000;

export interface Headline {
  readonly title: string;
  readonly url: string;
  /** The outlet, e.g. "NBC Sports". */
  readonly source: string;
  /** ISO timestamp. */
  readonly published: string;
}

export interface WebResult {
  readonly title: string;
  readonly url: string;
  /** Page text, in markdown, as Ollama returns it. */
  readonly content: string;
}

export interface GatheredItem {
  readonly playerId: string;
  readonly url: string;
  readonly source: string;
  /** YYYY-MM-DD, or "undated" for web search results, which carry no date. */
  readonly published: string;
  readonly title: string;
  readonly text?: string;
}

export interface GatherResult {
  /** Grouped by player in the order given, newest first within each. */
  readonly items: GatheredItem[];
  /** Web requests made. */
  readonly requests: number;
  /** Requests that failed; those players simply have fewer items. */
  readonly failed: number;
  /** The sources that were consulted, for the report. */
  readonly sourcesUsed: readonly string[];
  /** Problems worth telling the user about, e.g. a rejected web search key. */
  readonly warnings: readonly string[];
}

export class WebSearchError extends Error {
  constructor(
    readonly kind: 'auth' | 'limit' | 'network' | 'upstream',
    message: string,
  ) {
    super(message);
    this.name = 'WebSearchError';
  }
}

export function parseGoogleNewsRss(xml: string): Headline[] {
  const out: Headline[] = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = match[1] ?? '';
    const source = decode(tag(block, 'source'));
    let title = decode(tag(block, 'title'));
    // Google appends " - Outlet" to every title; the outlet is kept separately.
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim();
    const url = decode(tag(block, 'link'));
    const published = Date.parse(tag(block, 'pubDate'));
    if (!title || !/^https?:[/][/]/i.test(url) || Number.isNaN(published)) continue;
    out.push({ title, url, source: source || 'Google News', published: new Date(published).toISOString() });
  }
  return out;
}

/** A name as the news writes it: ESPN's "Kyle Pitts Sr." is reported as "Kyle Pitts". */
export function searchName(name: string): string {
  return name.replace(/\s+(Jr\.?|Sr\.?|II|III|IV|V)$/i, '').trim();
}

function surnameOf(name: string): string {
  const clean = searchName(name);
  return (clean.split(/\s+/).pop() ?? clean).toLowerCase();
}

/** Recent headlines that name the player, newest first. */
export async function searchPlayerHeadlines(
  name: string,
  opts: { days?: number; limit?: number; fetchImpl?: typeof fetch | undefined; now?: number | undefined } = {},
): Promise<Headline[]> {
  const days = opts.days ?? 7;
  const clean = searchName(name);
  const query = new URLSearchParams({ q: `"${clean}" NFL when:${days}d`, hl: 'en-US', gl: 'US', ceid: 'US:en' });
  const res = await (opts.fetchImpl ?? fetch)(`${GOOGLE_NEWS_RSS}?${query}`, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/rss+xml, application/xml' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Google News returned HTTP ${res.status}`);

  const cutoff = (opts.now ?? Date.now()) - days * DAY_MS;
  const surname = surnameOf(name);
  return parseGoogleNewsRss(await res.text())
    // The search matches article text; a headline that names the player is
    // far more likely to be about them.
    .filter((h) => Date.parse(h.published) >= cutoff && h.title.toLowerCase().includes(surname))
    .sort((a, b) => Date.parse(b.published) - Date.parse(a.published))
    .slice(0, opts.limit ?? 3);
}

/** One search with Ollama's web search API. */
export async function searchOllamaWeb(
  query: string,
  apiKey: string,
  opts: { maxResults?: number; fetchImpl?: typeof fetch | undefined } = {},
): Promise<WebResult[]> {
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(OLLAMA_WEB_SEARCH, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, max_results: opts.maxResults ?? 3 }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new WebSearchError(
      'network',
      `Could not reach Ollama web search: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new WebSearchError('auth', 'Ollama rejected the web search key. Check it at ollama.com/settings/keys.');
  }
  if (res.status === 429) {
    throw new WebSearchError('limit', 'Ollama web search is limiting this key right now. Try again later.');
  }
  if (!res.ok) throw new WebSearchError('upstream', `Ollama web search returned HTTP ${res.status}.`);

  const data = (await res.json()) as { results?: unknown };
  if (!Array.isArray(data.results)) {
    throw new WebSearchError('upstream', 'Ollama web search returned no results list.');
  }
  return data.results.flatMap((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const url = typeof r['url'] === 'string' ? r['url'] : '';
    if (!/^https?:[/][/]/i.test(url)) return [];
    const title = typeof r['title'] === 'string' && r['title'].trim() ? r['title'].trim() : url;
    return [{ title, url, content: typeof r['content'] === 'string' ? r['content'] : '' }];
  });
}

/** Check a web search key with the smallest possible search. */
export async function verifyOllamaSearchKey(apiKey: string, fetchImpl?: typeof fetch): Promise<void> {
  await searchOllamaWeb('NFL', apiKey, { maxResults: 1, fetchImpl });
}

/** ESPN blurbs, recent headlines, and optionally web search, for each player. Never throws. */
export async function gatherPlayerNews(
  players: readonly { readonly id: string; readonly name: string; readonly position: string }[],
  opts: {
    days?: number;
    headlinesPerPlayer?: number;
    fetchImpl?: typeof fetch | undefined;
    now?: number | undefined;
    concurrency?: number;
    /** Adds Ollama's web search as a source. */
    ollamaApiKey?: string | undefined;
  } = {},
): Promise<GatherResult> {
  const days = opts.days ?? 7;
  const now = opts.now ?? Date.now();
  const cutoff = now - days * DAY_MS;
  const byPlayer = new Map<string, GatheredItem[]>(players.map((p) => [p.id, []]));
  const add = (item: GatheredItem) => byPlayer.get(item.playerId)?.push(item);
  const sourcesUsed = ['ESPN', 'Google News'];
  const warnings: string[] = [];
  let failed = 0;

  const espn = await fetchNewsFor(
    players.map((p) => p.id),
    { maxAgeDays: days, perPlayer: 2, fetchImpl: opts.fetchImpl, ...(opts.now !== undefined ? { now: opts.now } : {}) },
  );
  failed += espn.failed.length;
  for (const p of players) {
    for (const n of espn.byPlayer.get(p.id) ?? []) {
      add({
        playerId: p.id,
        // ESPN's items carry no usable article link; the player page shows them.
        url: `https://www.espn.com/nfl/player/_/id/${p.id}`,
        source: 'ESPN',
        published: n.published.slice(0, 10),
        title: n.headline,
        ...(n.story ? { text: n.story.slice(0, 300) } : {}),
      });
    }
  }

  // A team defense is not a person the news names, so it gets no search.
  const searchable = players.filter((p) => p.position !== 'DST');

  const headlineQueue = [...searchable];
  const headlineWorker = async () => {
    for (let p = headlineQueue.shift(); p !== undefined; p = headlineQueue.shift()) {
      try {
        const headlines = await searchPlayerHeadlines(p.name, {
          days,
          limit: opts.headlinesPerPlayer ?? 3,
          fetchImpl: opts.fetchImpl,
          now: opts.now,
        });
        for (const h of headlines) {
          add({ playerId: p.id, url: h.url, source: h.source, published: h.published.slice(0, 10), title: h.title });
        }
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, headlineQueue.length) }, headlineWorker));

  let webSearches = 0;
  if (opts.ollamaApiKey) {
    const apiKey = opts.ollamaApiKey;
    sourcesUsed.push('Ollama web search');
    // Stop at the first rejected key or rate limit instead of failing once per player.
    let stopped = false;
    const webQueue = [...searchable];
    const webWorker = async () => {
      for (let p = webQueue.shift(); p !== undefined && !stopped; p = webQueue.shift()) {
        webSearches++;
        try {
          const surname = surnameOf(p.name);
          const results = await searchOllamaWeb(`${searchName(p.name)} NFL injury news`, apiKey, {
            maxResults: 3,
            fetchImpl: opts.fetchImpl,
          });
          for (const r of results) {
            const text = plainText(r.content);
            if (!`${r.title} ${text}`.toLowerCase().includes(surname)) continue;
            // Web results carry no date of their own. Keep only pages that state
            // one inside the window, so nothing older than a week is read.
            const published = articleDate(`${r.title} ${r.content}`, now);
            if (!published || Date.parse(published) < cutoff) continue;
            add({
              playerId: p.id,
              url: r.url,
              source: hostOf(r.url),
              published,
              title: r.title,
              ...(text ? { text: text.slice(0, 350) } : {}),
            });
          }
        } catch (error) {
          failed++;
          if (error instanceof WebSearchError && (error.kind === 'auth' || error.kind === 'limit')) {
            stopped = true;
            if (!warnings.includes(error.message)) warnings.push(error.message);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, webQueue.length) }, webWorker));
  }

  // Newest first within each player; undated web results after dated news.
  const dateKey = (i: GatheredItem) => (i.published === 'undated' ? '' : i.published);
  const items = players.flatMap((p) =>
    [...(byPlayer.get(p.id) ?? [])].sort((a, b) => dateKey(b).localeCompare(dateKey(a))),
  );
  return { items, requests: players.length + searchable.length + webSearches, failed, sourcesUsed, warnings };
}

function tag(block: string, name: string): string {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return match ? (match[1] ?? '').replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim() : '';
}

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

/** Markdown page text as plain sentences: links keep their words, markup goes. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*_`>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'web';
  }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * The most recent date a page states, as YYYY-MM-DD, ignoring dates in the
 * future. Web search results carry no date of their own, and a page with no
 * date cannot be shown to be from the last week, so this returns null for it.
 */
export function articleDate(text: string, now: number = Date.now()): string | null {
  const found: number[] = [];
  for (const m of text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) {
    found.push(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }
  for (const m of text.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2})\b/gi)) {
    found.push(Date.UTC(Number(m[3]), MONTHS.indexOf(m[1]!.toLowerCase()), Number(m[2])));
  }
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/g)) {
    found.push(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2])));
  }
  const valid = found.filter((t) => Number.isFinite(t) && t <= now + DAY_MS);
  return valid.length > 0 ? new Date(Math.max(...valid)).toISOString().slice(0, 10) : null;
}
