/**
 * Waiver-wire picks from the web: who the fantasy press says to add this week.
 *
 * Informational. No projection changes: the waiver page still ranks players by
 * what they add to your lineup this week, and shows web picks beside that
 * ranking, because the press often recommends players for the weeks after this
 * one. The same grounding rule as the news check applies: every pick must cite
 * a source the app knows was retrieved.
 */

import { LlmError, type LlmRequest, type ResearchRequest, type ResearchSource } from './types.js';
import { isStale, lastJsonBlock, normalizeUrl, weekBefore } from './research.js';

/** An article or headline the app gathered for a local model to read. */
export interface WaiverArticle {
  readonly url: string;
  readonly source: string;
  /** YYYY-MM-DD, or "undated". */
  readonly published: string;
  readonly title: string;
  readonly text?: string;
}

export interface WebPick {
  /** As the sources write it; matched to a player later. */
  readonly name: string;
  readonly position: string | null;
  readonly reason: string;
  readonly sources: readonly ResearchSource[];
}

export interface ParsedPicks {
  readonly picks: WebPick[];
  readonly rejected: { readonly player: string; readonly reason: string }[];
}

const FENCE = '```';
const MAX_PICKS = 15;
const POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DST']);

function rules(week: number, sourcesRule: string, example: string): string {
  return `List the players the sources recommend adding for week ${week}, most recommended first, at most ${MAX_PICKS}. Include team defenses and kickers if they are recommended as streamers. For each give:
- player: the full name as written (for a defense, the team name followed by "D/ST", e.g. "Panthers D/ST")
- position: QB, RB, WR, TE, K, or DST, if the source says
- reason: one plain sentence on why, e.g. a starter's injury, a bigger role, a good matchup
- sources: ${sourcesRule}

Only include players the sources actually recommend adding. Leave out players named only as drops, for other weeks, or in college football. Never guess. End with one JSON block and nothing after it:
${FENCE}json
{"picks": [{"player": "Full Name", "position": "RB", "reason": "…", "sources": ${example}}]}
${FENCE}
Use {"picks": []} when the sources recommend no one.`;
}

/** For a model that searches the web itself (Claude). */
export function waiverPicksResearchRequest(input: { readonly week: number; readonly today: string }): ResearchRequest {
  const system = `You find this week's fantasy football waiver wire recommendations using web search. Today is ${input.today}. The manager is picking up players for week ${input.week} of the NFL season.

Search for current week ${input.week} waiver wire articles from established fantasy outlets such as ESPN, NFL.com, Yahoo, CBS, FantasyPros, and The Athletic. Use only articles published in the last 7 days, on or after ${weekBefore(input.today)}.

${rules(input.week, 'the URLs of the articles, exactly as your searches returned them', '["https://…"]')}`;
  return { system, user: `Find the week ${input.week} fantasy football waiver wire pickups.`, maxSearches: 5, timeoutMs: 300_000 };
}

/**
 * For a model that cannot search (a local model): the headlines and articles
 * the app gathered, numbered. Returns the request and the sources in the same
 * order, for `parseWaiverPicks(..., { numbered: true })`.
 */
export function waiverPicksDigestRequest(input: {
  readonly week: number;
  readonly today: string;
  readonly items: readonly WaiverArticle[];
}): { request: LlmRequest; sources: ResearchSource[] } {
  const sources: ResearchSource[] = input.items.map((i) => ({ url: i.url, title: `${i.source}: ${i.title}`, published: i.published }));
  const lines = input.items.map(
    (i, n) => `[${n + 1}] ${i.published}, ${i.source}: ${i.title}${i.text ? `\n${i.text}` : ''}`,
  );

  const system = `You read fantasy football waiver wire headlines and articles that were gathered for a manager. Today is ${input.today}. The manager is picking up players for week ${input.week} of the NFL season.

Each item below is numbered. Use only these items; a headline that names players as top adds counts as a recommendation.

${rules(input.week, 'the numbers of the items that recommend the player', '[2, 5]')}`;

  const user = [`Waiver wire items gathered for week ${input.week}:`, '', lines.join('\n\n')].join('\n');
  const estimate = Math.ceil((system.length + user.length) / 3) + 2_000;
  const contextTokens = Math.min(32_768, Math.max(8_192, Math.ceil(estimate / 4_096) * 4_096));
  return { request: { system, user, contextTokens, timeoutMs: 600_000 }, sources };
}

/** Keep the picks that name someone, give a reason, and cite a retrieved source. */
export function parseWaiverPicks(
  text: string,
  retrieved: readonly ResearchSource[],
  options: { readonly numbered?: boolean; readonly notBefore?: number; readonly now?: number } = {},
): ParsedPicks {
  const json = lastJsonBlock(text, 'picks');
  if (!json) throw new LlmError('bad-response', 'The model did not end with picks in the agreed format.');
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new LlmError('bad-response', "The model's picks were not valid JSON.");
  }
  const items = (data as { picks?: unknown } | null)?.picks;
  if (!Array.isArray(items)) throw new LlmError('bad-response', "The model's answer had no picks list.");

  const pages = new Map(retrieved.map((s) => [normalizeUrl(s.url), s]));
  const lookup = (cited: unknown): ResearchSource | undefined => {
    if (options.numbered) {
      const n = typeof cited === 'number' ? cited : typeof cited === 'string' ? Number(cited.replace(/[[\]\s]/g, '')) : NaN;
      if (Number.isInteger(n) && n >= 1 && n <= retrieved.length) return retrieved[n - 1];
    }
    return typeof cited === 'string' ? pages.get(normalizeUrl(cited)) : undefined;
  };

  const picks: WebPick[] = [];
  const rejected: { player: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const raw of items) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const name = typeof item['player'] === 'string' ? item['player'].trim().slice(0, 60) : '';
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;

    const reason = typeof item['reason'] === 'string' ? item['reason'].trim().slice(0, 300) : '';
    if (!reason) {
      rejected.push({ player: name, reason: 'no reason given' });
      continue;
    }

    const cited = Array.isArray(item['sources']) ? (item['sources'] as unknown[]) : [];
    const grounded = new Map<string, ResearchSource>();
    let stale = 0;
    for (const c of cited) {
      const s = lookup(c);
      if (!s) continue;
      if (isStale(s, options)) {
        stale++;
        continue;
      }
      grounded.set(normalizeUrl(s.url), s);
    }
    if (grounded.size === 0) {
      rejected.push({
        player: name,
        reason: stale > 0 ? 'its sources are more than a week old' : cited.length > 0 ? 'cited sources that were never retrieved' : 'no sources',
      });
      continue;
    }

    const rawPos = typeof item['position'] === 'string' ? item['position'].toUpperCase().replace('D/ST', 'DST') : '';
    seen.add(key);
    picks.push({
      name,
      position: POSITIONS.has(rawPos) ? rawPos : null,
      reason,
      sources: [...grounded.values()].map(({ url, title }) => ({ url, title })),
    });
    if (picks.length >= MAX_PICKS) break;
  }

  return { picks, rejected };
}
