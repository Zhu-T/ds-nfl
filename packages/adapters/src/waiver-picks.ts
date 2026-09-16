/**
 * Waiver-wire articles gathered for a local model, and the picks saved per
 * league and week.
 *
 * Headlines come from Google News search (no key), and the fantasy press
 * usually names its top adds right in the headline. With an Ollama web search
 * key, full article text is added, which carries the complete lists.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './credentials.js';
import { WebSearchError, articleDate, hostOf, parseGoogleNewsRss, plainText, searchName, searchOllamaWeb } from './web-news.js';

const GOOGLE_NEWS_RSS = 'https://news.google.com/rss/search';
const DAY_MS = 86_400_000;

export interface WaiverArticle {
  readonly url: string;
  readonly source: string;
  /** YYYY-MM-DD, or "undated" for web search results. */
  readonly published: string;
  readonly title: string;
  readonly text?: string;
}

/**
 * Headlines about this week's waiver wire, newest first. College fantasy and
 * articles about another week are left out.
 */
export async function gatherWaiverArticles(
  week: number,
  opts: {
    days?: number;
    limit?: number;
    fetchImpl?: typeof fetch | undefined;
    now?: number | undefined;
    ollamaApiKey?: string | undefined;
  } = {},
): Promise<{ items: WaiverArticle[]; requests: number; sourcesUsed: string[]; warnings: string[] }> {
  const days = opts.days ?? 7;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const cutoff = (opts.now ?? Date.now()) - days * DAY_MS;
  const items: WaiverArticle[] = [];
  const sourcesUsed = ['Google News'];
  const warnings: string[] = [];
  let requests = 0;

  const query = new URLSearchParams({
    q: `fantasy football "waiver wire" week ${week} when:${days}d`,
    hl: 'en-US',
    gl: 'US',
    ceid: 'US:en',
  });
  requests++;
  try {
    const res = await fetchImpl(`${GOOGLE_NEWS_RSS}?${query}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/rss+xml, application/xml' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Google News returned HTTP ${res.status}`);
    const thisWeek = new RegExp(`\\bweek\\s*${week}\\b`, 'i');
    for (const h of parseGoogleNewsRss(await res.text())) {
      const otherWeek = /\bweek\s*\d+\b/i.test(h.title) && !thisWeek.test(h.title);
      if (Date.parse(h.published) < cutoff || otherWeek || /college/i.test(h.title) || !/waiver|pickup|add/i.test(h.title)) continue;
      items.push({ url: h.url, source: h.source, published: h.published.slice(0, 10), title: h.title });
    }
  } catch (error) {
    warnings.push(`Google News could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  items.sort((a, b) => b.published.localeCompare(a.published));
  items.splice(opts.limit ?? 20);

  if (opts.ollamaApiKey) {
    sourcesUsed.push('Ollama web search');
    requests++;
    try {
      const results = await searchOllamaWeb(`fantasy football week ${week} waiver wire pickups`, opts.ollamaApiKey, {
        maxResults: 5,
        fetchImpl: opts.fetchImpl,
      });
      for (const r of results) {
        // Only pages that state a date inside the window; web results carry none of their own.
        const published = articleDate(`${r.title} ${r.content}`, opts.now ?? Date.now());
        if (!published || Date.parse(published) < cutoff) continue;
        const text = plainText(r.content);
        items.push({ url: r.url, source: hostOf(r.url), published, title: r.title, ...(text ? { text: text.slice(0, 1_500) } : {}) });
      }
    } catch (error) {
      warnings.push(error instanceof WebSearchError ? error.message : `Ollama web search failed: ${String(error)}`);
    }
  }

  return { items, requests, sourcesUsed, warnings };
}

/** A web pick matched to the league. */
export interface MatchedPick {
  readonly name: string;
  readonly position: string | null;
  readonly reason: string;
  readonly sources: readonly { readonly url: string; readonly title: string }[];
  /** The ESPN player id, when the name matched a player. */
  readonly playerId: string | null;
  /** Where the player is in this league right now. */
  readonly status: 'free-agent' | 'waivers' | 'rostered' | 'not-found';
  /** The fantasy team that has them, when rostered. */
  readonly rosteredBy?: string;
}

export interface WebPicksReport {
  readonly leagueKey: string;
  readonly week: number;
  readonly checkedAt: string;
  readonly model: string;
  readonly method: 'web-search' | 'gathered';
  /** Items the model read (gathered) or web searches run (Claude). */
  readonly itemsRead: number;
  readonly sourcesUsed: readonly string[];
  readonly picks: readonly MatchedPick[];
  readonly rejected: readonly { readonly player: string; readonly reason: string }[];
}

function defaultDir(): string {
  return join(dataDir(), 'web-picks');
}

function fileFor(leagueKey: string, week: number, dir: string): string {
  return join(dir, `${leagueKey.replace(/[^a-zA-Z0-9_-]+/g, '_')}_w${week}.json`);
}

export function readWebPicks(leagueKey: string, week: number, dir: string = defaultDir()): WebPicksReport | null {
  const path = fileFor(leagueKey, week, dir);
  if (!existsSync(path)) return null;
  try {
    const report = JSON.parse(readFileSync(path, 'utf8')) as WebPicksReport;
    return Array.isArray(report?.picks) ? report : null;
  } catch {
    return null;
  }
}

export function writeWebPicks(report: WebPicksReport, dir: string = defaultDir()): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(fileFor(report.leagueKey, report.week, dir), JSON.stringify(report, null, 2), 'utf8');
}

export function clearWebPicks(leagueKey: string, week: number, dir: string = defaultDir()): void {
  rmSync(fileFor(leagueKey, week, dir), { force: true });
}

/** A name compared the way the press writes it: case, punctuation, and suffixes aside. */
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\.?$/i, '')
    .replace(/d\s*\/\s*st\b/g, 'dst')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** A league player a web pick can match: where they are in this league. */
export interface LeaguePlayerRef {
  readonly id: string;
  readonly name: string;
  readonly status: 'free-agent' | 'waivers' | 'rostered';
  readonly rosteredBy?: string;
  /** ESPN's position, which wins over whatever the sources or the model said. */
  readonly position?: string;
}

/**
 * Match web picks to the league's players by name. Available players are
 * checked before rostered ones, so a pickup is never hidden behind a
 * same-named player on a roster.
 */
export function matchPicks(
  picks: readonly Pick<MatchedPick, 'name' | 'position' | 'reason' | 'sources'>[],
  players: readonly LeaguePlayerRef[],
): MatchedPick[] {
  const byName = new Map<string, LeaguePlayerRef>();
  const ordered = [...players.filter((p) => p.status !== 'rostered'), ...players.filter((p) => p.status === 'rostered')];
  for (const p of ordered) {
    const key = nameKey(p.name);
    if (!byName.has(key)) byName.set(key, p);
  }
  return picks.map((pick) => {
    const hit = byName.get(nameKey(pick.name));
    return hit
      ? {
          ...pick,
          position: hit.position ?? pick.position,
          playerId: hit.id,
          status: hit.status,
          ...(hit.rosteredBy ? { rosteredBy: hit.rosteredBy } : {}),
        }
      : { ...pick, playerId: null, status: 'not-found' as const };
  });
}

/**
 * Which of the given players the gathered articles name, and where.
 *
 * No model involved: every player's full name (suffixes aside) is looked for,
 * as whole words, in each headline and article text. It catches the names a
 * local model skips, and cannot invent one. Team defenses are left out, since
 * the press writes "the Panthers defense" rather than "Panthers D/ST".
 */
export function scanMentions(
  items: readonly WaiverArticle[],
  players: readonly { readonly id: string; readonly name: string; readonly position?: string }[],
): Map<string, WaiverArticle[]> {
  const found = new Map<string, WaiverArticle[]>();
  const texts = items.map((i) => `${i.title} ${i.text ?? ''}`.toLowerCase());
  for (const p of players) {
    if (p.position === 'DST') continue;
    const name = searchName(p.name).toLowerCase();
    if (name.split(/\s+/).length < 2) continue;
    const pattern = new RegExp(`(^|[^a-z])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z])`);
    const hits = items.filter((_, i) => pattern.test(texts[i]!));
    if (hits.length > 0) found.set(p.id, hits);
  }
  return found;
}
