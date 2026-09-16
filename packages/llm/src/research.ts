/**
 * News research: the request a model gets, and the checks its answer must pass.
 *
 * Two ways in, one set of checks:
 *   - Claude searches the web itself (`newsResearchRequest`). The pages its
 *     searches returned are the only sources it may cite.
 *   - A local model cannot search, so the app gathers the news first — ESPN's
 *     player blurbs and recent headlines — and the model only reads it
 *     (`newsDigestRequest`). The numbered items are the only sources it may cite.
 *
 * Either way this is the one place a model's output changes a recommendation,
 * so the answer is treated as evidence with limits:
 *   - only players from the list the app sent can be named;
 *   - every finding must cite at least one source the app knows was retrieved,
 *     and for gathered news, one gathered about that same player;
 *   - a status can only move a projection within the engine's fixed range;
 *   - each finding is shown with its sources and can be switched off.
 */

import { FACTOR_RANGE, boundFactor, type NewsFinding, type NewsStatus } from '@ds-nfl/core';
import { LlmError, type LlmRequest, type ResearchRequest, type ResearchSource } from './types.js';

export interface ResearchPlayer {
  readonly id: string;
  readonly name: string;
  readonly position: string;
  readonly proTeam: string | null;
  readonly projected: number;
  readonly role: 'starter' | 'bench' | 'pickup' | 'rostered' | 'other';
  /** Context from the injury report, e.g. that a teammate ahead of them is out. */
  readonly context?: string;
}

/** One news item the app gathered, for a local model to read. */
export interface DigestItem {
  readonly playerId: string;
  readonly url: string;
  /** Where it came from, e.g. "ESPN" or "NBC Sports". */
  readonly source: string;
  /** YYYY-MM-DD. */
  readonly published: string;
  readonly title: string;
  /** Body text, when the source provides one (ESPN's blurbs do). */
  readonly text?: string;
}

export interface RejectedFinding {
  readonly player: string;
  readonly reason: string;
}

export interface ParsedNews {
  readonly findings: NewsFinding[];
  readonly rejected: RejectedFinding[];
}

const STATUSES: readonly NewsStatus[] = ['out', 'doubtful', 'questionable', 'active'];
const FENCE = '```';
const ROLE_LABEL: Record<ResearchPlayer['role'], string> = {
  starter: 'in the recommended lineup',
  bench: 'on the bench',
  pickup: 'a possible waiver pickup',
  rostered: 'on your roster',
  other: 'on another fantasy team',
};

function playerLine(p: ResearchPlayer): string {
  return `${p.name} (${p.position}${p.proTeam ? `, ${p.proTeam}` : ''}): ${ROLE_LABEL[p.role]}, ESPN projects ${p.projected.toFixed(1)}${p.context ? `; ${p.context}` : ''}`;
}

/** The part of the instructions both paths share: what to report, and how. */
function reportRules(week: number, sourcesRule: string, example: string): string {
  const ranges = STATUSES.map((s) => `${s} ${FACTOR_RANGE[s][0]} to ${FACTOR_RANGE[s][1]}`).join('; ');
  return `Report only players whose outlook has materially changed, and leave everyone else out. For each one give:
- status: out, doubtful, questionable, or active
- factor: a multiplier on their current projection, inside the range for the status (${ranges}). Use 1 when the news should not change the projection, and go above 1 only for a clearly bigger role.
- summary: one or two plain sentences, including the date of the report
- sources: ${sourcesRule}

A note that a teammate ahead of a player is out comes from the injury report: if the news says the player takes over that work, report the bigger role as active, with a factor above 1.

Never guess. If reports conflict, go with the most recent and say so in the summary. End your answer with one JSON block and nothing after it:
${FENCE}json
{"findings": [{"player": "Exact Name From The List", "status": "questionable", "factor": 0.9, "summary": "…", "sources": ${example}}]}
${FENCE}
Use {"findings": []} when nothing has changed for week ${week}.`;
}

/** For a model that searches the web itself (Claude). */
export function newsResearchRequest(input: {
  readonly leagueName: string;
  readonly week: number;
  readonly today: string;
  readonly players: readonly ResearchPlayer[];
}): ResearchRequest {
  const system = `You research the latest NFL news for a fantasy football manager, using web search. Today is ${input.today}. The manager is planning for week ${input.week} of the NFL season.

For each listed player, look for reports that change their outlook for their week ${input.week} game: injury designations and practice participation, being ruled out or activated, suspensions, depth chart or role changes, and a change of starting quarterback on their team. Prefer the most recent reports from team sites, the NFL, ESPN, and established beat reporters. Ignore news that has since been resolved. Use only reports published in the last 7 days, on or after ${weekBefore(input.today)}; ignore anything older, however relevant it looks.

${reportRules(input.week, 'the URLs of the pages the report came from, exactly as your searches returned them', '["https://…"]')}`;

  const user = [
    `League: ${input.leagueName}. Players to check for week ${input.week}:`,
    ...input.players.map((p) => `- ${playerLine(p)}`),
  ].join('\n');

  // Roughly one search per three players, within limits that keep the cost of
  // a check predictable.
  const maxSearches = Math.min(12, Math.max(4, Math.ceil(input.players.length / 3)));
  return { system, user, maxSearches, timeoutMs: 300_000 };
}

/**
 * For a model that cannot search (a local model): the news the app gathered,
 * numbered and grouped by player. Returns the request and the sources in the
 * same numbered order, for `parseNewsFindings(..., { numbered: true })`.
 */
export function newsDigestRequest(input: {
  readonly leagueName: string;
  readonly week: number;
  readonly today: string;
  readonly players: readonly ResearchPlayer[];
  readonly items: readonly DigestItem[];
}): { request: LlmRequest; sources: ResearchSource[] } {
  const sources: ResearchSource[] = [];
  const blocks: string[] = [];

  for (const p of input.players) {
    const mine = input.items.filter((i) => i.playerId === p.id);
    if (mine.length === 0) {
      blocks.push(`${playerLine(p)}\n(no news found)`);
      continue;
    }
    const lines = mine.map((i) => {
      sources.push({ url: i.url, title: `${i.source}: ${i.title}`, about: p.id, published: i.published });
      const body = i.text ? ` ${i.text}` : '';
      return `[${sources.length}] ${i.published}, ${i.source}: ${i.title}${body}`;
    });
    blocks.push(`${playerLine(p)}\n${lines.join('\n')}`);
  }

  const system = `You read recent NFL news that was gathered for a fantasy football manager. Today is ${input.today}. The manager is planning for week ${input.week} of the NFL season.

Each news item below is numbered and listed under the player it was gathered for. Using only these items, decide which players' outlook for their week ${input.week} game has materially changed: injury designations and practice participation, being ruled out or activated, suspensions, depth chart or role changes, or a change of starting quarterback. A game recap on its own is not a change. Ignore news that a later item shows was resolved.

${reportRules(input.week, 'the numbers of the items the finding is based on, taken from that player\'s own list', '[3, 7]')}`;

  const user = [`League: ${input.leagueName}. News gathered for week ${input.week}, by player:`, '', blocks.join('\n\n')].join('\n');

  // Ollama cuts long prompts off silently unless asked for a bigger window:
  // about three characters per token, plus room for the answer.
  const estimate = Math.ceil((system.length + user.length) / 3) + 2_000;
  const contextTokens = Math.min(32_768, Math.max(8_192, Math.ceil(estimate / 4_096) * 4_096));

  return { request: { system, user, contextTokens, timeoutMs: 600_000 }, sources };
}

/** Compare URLs the way a person would: scheme, trailing slash, and fragment aside. */
export function normalizeUrl(url: string): string {
  return url
    .trim()
    .replace(/#.*$/, '')
    .replace(/\/+$/, '')
    .replace(/^http:/i, 'https:')
    .toLowerCase();
}

/**
 * Keep the findings that pass every check.
 *
 * With `numbered`, sources may be given as item numbers ("3", 3, or "[3]") that
 * index into `retrieved`; otherwise only URLs the search returned count.
 */
export function parseNewsFindings(
  text: string,
  players: readonly ResearchPlayer[],
  retrieved: readonly ResearchSource[],
  options: { readonly numbered?: boolean; readonly notBefore?: number; readonly now?: number } = {},
): ParsedNews {
  const json = lastJsonBlock(text);
  if (!json) {
    throw new LlmError('bad-response', 'The model did not end its report with findings in the agreed format.');
  }
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new LlmError('bad-response', "The model's findings were not valid JSON.");
  }
  const items = (data as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(items)) {
    throw new LlmError('bad-response', "The model's report had no findings list.");
  }

  const byName = new Map(players.map((p) => [p.name.trim().toLowerCase(), p]));
  const pages = new Map(retrieved.map((s) => [normalizeUrl(s.url), s]));
  const lookup = (cited: unknown): ResearchSource | undefined => {
    if (options.numbered) {
      const n = typeof cited === 'number' ? cited : typeof cited === 'string' ? Number(cited.replace(/[[\]\s]/g, '')) : NaN;
      if (Number.isInteger(n) && n >= 1 && n <= retrieved.length) return retrieved[n - 1];
    }
    return typeof cited === 'string' ? pages.get(normalizeUrl(cited)) : undefined;
  };

  const findings: NewsFinding[] = [];
  const rejected: RejectedFinding[] = [];
  const seen = new Set<string>();

  for (const raw of items) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const name = typeof item['player'] === 'string' ? item['player'].trim() : '';
    const player = byName.get(name.toLowerCase());
    if (!player) {
      rejected.push({ player: name || '(unnamed)', reason: 'not one of the players the app asked about' });
      continue;
    }
    if (seen.has(player.id)) continue;

    const status = item['status'];
    if (typeof status !== 'string' || !STATUSES.includes(status as NewsStatus)) {
      rejected.push({ player: player.name, reason: `unknown status "${String(status)}"` });
      continue;
    }

    const summary = typeof item['summary'] === 'string' ? item['summary'].trim().slice(0, 400) : '';
    if (!summary) {
      rejected.push({ player: player.name, reason: 'no summary' });
      continue;
    }

    const cited = Array.isArray(item['sources']) ? (item['sources'] as unknown[]) : [];
    const found = cited.map(lookup).filter((s): s is ResearchSource => s !== undefined);
    // News gathered about another player cannot support this one.
    const grounded = new Map<string, ResearchSource>();
    let stale = 0;
    for (const s of found) {
      if (s.about !== undefined && s.about !== player.id) continue;
      if (isStale(s, options)) {
        stale++;
        continue;
      }
      grounded.set(normalizeUrl(s.url), s);
    }
    if (grounded.size === 0) {
      rejected.push({
        player: player.name,
        reason: stale > 0
          ? 'its sources are more than a week old'
          : found.length > 0
            ? 'cited news gathered about a different player'
            : cited.length > 0
              ? 'cited sources that were never retrieved'
              : 'no sources',
      });
      continue;
    }

    seen.add(player.id);
    findings.push({
      playerId: player.id,
      playerName: player.name,
      status: status as NewsStatus,
      factor: boundFactor(status as NewsStatus, typeof item['factor'] === 'number' ? item['factor'] : 1),
      summary,
      sources: [...grounded.values()].map(({ url, title }) => ({ url, title })),
    });
  }

  return { findings, rejected };
}

/**
 * The JSON block a model ended with: the last fenced block, or else the last
 * complete object that starts with the expected key. Local models sometimes
 * drop the fence, write the block twice, or add a line after it.
 */
export function lastJsonBlock(text: string, key = 'findings'): string | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  if (fenced.length > 0) return fenced[fenced.length - 1]![1]!.trim();
  const starts = [...text.matchAll(new RegExp(`\\{\\s*"${key}"`, 'g'))].map((m) => m.index!);
  for (const start of starts.reverse()) {
    const end = objectEnd(text, start);
    if (end !== null) return text.slice(start, end + 1);
  }
  return null;
}

/** Where the object opening at `start` closes, ignoring braces inside strings; null if it never does. */
function objectEnd(text: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return null;
}

/** The date seven days before a YYYY-MM-DD date: the start of the news window. */
export function weekBefore(today: string): string {
  const t = Date.parse(`${today}T00:00:00Z`);
  return Number.isNaN(t) ? today : new Date(t - 7 * 86_400_000).toISOString().slice(0, 10);
}

const AGE_UNIT_MS: Record<string, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,
  year: 31_536_000_000,
};

/** When a source says it was published, as epoch ms; null when it does not say or cannot be read. */
export function sourceTime(published: string | undefined, now: number = Date.now()): number | null {
  if (!published) return null;
  const rel = /^(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$/i.exec(published.trim());
  if (rel) return now - Number(rel[1]) * AGE_UNIT_MS[rel[2]!.toLowerCase()]!;
  const t = Date.parse(published);
  return Number.isNaN(t) ? null : t;
}

/** A source that says it is older than the window. One that gives no date is not stale by this test. */
export function isStale(source: ResearchSource, options: { readonly notBefore?: number; readonly now?: number }): boolean {
  if (options.notBefore === undefined) return false;
  const t = sourceTime(source.published, options.now);
  return t !== null && t < options.notBefore;
}
