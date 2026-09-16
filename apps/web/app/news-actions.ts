'use server';

import { openedRoleNote } from '@ds-nfl/core';
import { formSentence } from '@/lib/form-label';
import { revalidatePath } from 'next/cache';
import { clearNewsReport, gatherPlayerNews, setFindingEnabled, writeNewsReport } from '@ds-nfl/adapters';
import {
  LlmError,
  newsDigestRequest,
  newsResearchRequest,
  parseNewsFindings,
  type ParsedNews,
  type ResearchPlayer,
} from '@ds-nfl/llm';
import type { OptimizerPlayer } from '@ds-nfl/core';
import { aiSettings, currentProvider } from '@/lib/ai';
import { planLineup } from '@/lib/week';
import { loadWaivers } from '@/lib/league-data';

export interface NewsCheckResult {
  readonly ok: boolean;
  readonly message: string;
}

/** Pickups researched along with the roster: the ones that would most improve it. */
const PICKUPS = 5;
/** Backups whose lead teammate is out, checked too: the news may show the work is theirs. */
const OPENED_PICKUPS = 4;
/** How far back news is gathered for a local model. */
const NEWS_DAYS = 7;
/** Sources older than this are refused, whoever found them. */
const WINDOW_MS = NEWS_DAYS * 86_400_000;

/**
 * Check the news for this week's players, and save what passes the checks in
 * `parseNewsFindings`.
 *
 * Claude searches the web itself. A local model cannot, so the app gathers the
 * last week of ESPN player news and headlines first, and the model reads only
 * that; no API key is needed. Only runs when clicked. Players whose game has
 * already started are left out, since no news can change their week.
 */
export async function checkWebNews(key: string, week: number): Promise<NewsCheckResult> {
  let provider;
  try {
    provider = currentProvider();
  } catch (error) {
    return fail(error);
  }
  if (!provider) {
    return { ok: false, message: 'Checking news needs an AI provider. Turn one on under Connect a league.' };
  }

  let plan;
  try {
    plan = await planLineup(key, week);
  } catch (error) {
    return fail(error);
  }
  if (!plan) return { ok: false, message: 'That league is no longer connected. Reload the page.' };

  const teamOf = new Map(plan.roster.map((p) => [p.platformPlayerId, p.proTeam]));
  const waivers = await loadWaivers(key, plan.week);
  // Injured lead teammates, across the league when the waiver pool loaded.
  const openings = waivers.state === 'ok' ? new Map(Object.entries(waivers.data.openings)) : plan.openings;
  // Research from the platform's projection, not one a previous check adjusted.
  const asResearched = (p: OptimizerPlayer, role: ResearchPlayer['role'], proTeam: string | null): ResearchPlayer => {
    const opening = openings.get(p.gsisId);
    const context = [opening ? openedRoleNote(opening, p.position) : null, p.form ? formSentence(p.form) : null]
      .filter(Boolean)
      .join('; ');
    return {
      id: p.gsisId,
      name: p.name,
      position: p.position,
      proTeam,
      projected: p.market?.espn ?? p.matchup?.from ?? p.form?.from ?? p.news?.from ?? p.projectedPoints,
      role,
      ...(context ? { context } : {}),
    };
  };

  const starters = plan.optimal.starters.flatMap((s) =>
    s.player && !s.player.lockedToSlot ? [asResearched(s.player, 'starter', teamOf.get(s.player.gsisId) ?? null)] : [],
  );
  const bench = plan.optimal.bench
    .filter((p) => !p.lockedToSlot)
    .map((p) => asResearched(p, 'bench', teamOf.get(p.gsisId) ?? null));

  const pickups: ResearchPlayer[] = [];
  if (waivers.state === 'ok') {
    const { candidates, proTeamById } = waivers.data;
    const helpful = candidates.filter((c) => c.lineupGain > 0).slice(0, PICKUPS);
    const nextUp = candidates.filter((c) => openings.has(c.player.gsisId) && !helpful.includes(c)).slice(0, OPENED_PICKUPS);
    for (const c of [...helpful, ...nextUp]) pickups.push(asResearched(c.player, 'pickup', proTeamById[c.player.gsisId] ?? null));
  }

  const players = [...starters, ...bench, ...pickups];
  if (players.length === 0) {
    return { ok: false, message: `Every player's week ${plan.week} game has started, so no news can change it.` };
  }
  const today = new Date().toISOString().slice(0, 10);

  let parsed: ParsedNews;
  let model: string;
  let searches: number;
  let itemsRead: number | null = null;
  let sourcesUsed: readonly string[] = [];
  let warnings: readonly string[] = [];
  try {
    if (provider.research) {
      const result = await provider.research(
        newsResearchRequest({ leagueName: plan.league.name, week: plan.week, today, players }),
      );
      parsed = parseNewsFindings(result.text, players, result.sources, { notBefore: Date.now() - WINDOW_MS });
      model = result.model;
      searches = result.searches;
    } else {
      const searchKey = aiSettings().ollamaApiKey;
      const news = await gatherPlayerNews(
        players.map((p) => ({ id: p.id, name: p.name, position: p.position })),
        { days: NEWS_DAYS, ...(searchKey ? { ollamaApiKey: searchKey } : {}) },
      );
      sourcesUsed = news.sourcesUsed;
      warnings = news.warnings;
      searches = news.requests;
      itemsRead = news.items.length;
      model = provider.model;
      if (news.items.length === 0) {
        parsed = { findings: [], rejected: [] };
      } else {
        const { request, sources } = newsDigestRequest({
          leagueName: plan.league.name,
          week: plan.week,
          today,
          players,
          items: news.items,
        });
        const out = await provider.complete(request);
        parsed = parseNewsFindings(out.text, players, sources, { numbered: true, notBefore: Date.now() - WINDOW_MS });
        model = out.model;
      }
    }
  } catch (error) {
    return fail(error);
  }

  writeNewsReport({
    leagueKey: plan.key,
    week: plan.week,
    checkedAt: new Date().toISOString(),
    model,
    searches,
    findings: parsed.findings,
    rejected: parsed.rejected,
    disabled: [],
    method: itemsRead === null ? 'web-search' : 'gathered',
    ...(itemsRead !== null ? { itemsRead, sourcesUsed } : {}),
  });
  revalidatePath('/', 'layout');

  const n = parsed.findings.length;
  const dropped = parsed.rejected.length;
  const found =
    itemsRead === 0
      ? `No news in the last ${NEWS_DAYS} days for these players.`
      : n === 0
        ? `Nothing found that changes your players' outlook for week ${plan.week}.`
        : `${n} ${n === 1 ? 'finding' : 'findings'} applied to week ${plan.week}.`;
  return {
    ok: true,
    message:
      found +
      (dropped > 0 ? ` ${dropped} dropped because ${dropped === 1 ? 'it' : 'they'} could not be verified.` : '') +
      (warnings.length > 0 ? ` ${warnings.join(' ')}` : ''),
  };
}

/** Use or ignore one finding. */
export async function toggleFinding(key: string, week: number, playerId: string, enabled: boolean): Promise<void> {
  setFindingEnabled(key, week, playerId, enabled);
  revalidatePath('/', 'layout');
}

/** Remove a week's findings; projections go back to the platform's. */
export async function clearWebNews(key: string, week: number): Promise<void> {
  clearNewsReport(key, week);
  revalidatePath('/', 'layout');
}

function fail(error: unknown): NewsCheckResult {
  const message =
    error instanceof LlmError ? error.message : error instanceof Error ? error.message : String(error);
  return { ok: false, message };
}
