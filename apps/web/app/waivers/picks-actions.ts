'use server';

import {
  clearWebPicks,
  gatherWaiverArticles,
  matchPicks,
  scanMentions,
  writeWebPicks,
  type LeaguePlayerRef,
  type MatchedPick,
  type RosterPlayer,
  type WaiverArticle,
} from '@ds-nfl/adapters';
import {
  LlmError,
  parseWaiverPicks,
  waiverPicksDigestRequest,
  waiverPicksResearchRequest,
  type ParsedPicks,
} from '@ds-nfl/llm';
import { aiSettings, currentProvider } from '@/lib/ai';
import { planLineup } from '@/lib/week';

export interface PicksResult {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * Find this week's waiver-wire picks on the web and compare them with the
 * players actually available in this league.
 *
 * Claude searches the web itself. A local model reads waiver headlines the app
 * gathers from Google News (and article text from Ollama web search, if a key
 * is saved). Either way each pick must cite a retrieved source, and is then
 * matched by name against this league's free agents, waiver players, and
 * rosters. Informational only: no projection changes.
 */
export async function checkWaiverPicks(key: string, week: number): Promise<PicksResult> {
  let provider;
  try {
    provider = currentProvider('judgment');
  } catch (error) {
    return fail(error);
  }
  if (!provider) return { ok: false, message: 'Finding web picks needs an AI provider. Turn one on under Connect a league.' };

  let plan;
  try {
    plan = await planLineup(key, week);
  } catch (error) {
    return fail(error);
  }
  if (!plan) return { ok: false, message: 'That league is no longer connected. Reload the page.' };
  const today = new Date().toISOString().slice(0, 10);

  let parsed: ParsedPicks;
  let model: string;
  let method: 'web-search' | 'gathered';
  let itemsRead: number;
  let sourcesUsed: string[];
  let warnings: string[] = [];
  let gatheredItems: WaiverArticle[] = [];
  try {
    if (provider.research) {
      const result = await provider.research(waiverPicksResearchRequest({ week: plan.week, today }));
      parsed = parseWaiverPicks(result.text, result.sources, { notBefore: Date.now() - 7 * 86_400_000 });
      model = result.model;
      method = 'web-search';
      itemsRead = result.searches;
      sourcesUsed = ['web search'];
    } else {
      const gathered = await gatherWaiverArticles(plan.week, { ollamaApiKey: aiSettings().ollamaApiKey });
      gatheredItems = gathered.items;
      method = 'gathered';
      itemsRead = gathered.items.length;
      sourcesUsed = gathered.sourcesUsed;
      warnings = gathered.warnings;
      model = provider.model;
      if (gathered.items.length === 0) {
        parsed = { picks: [], rejected: [] };
      } else {
        const { request, sources } = waiverPicksDigestRequest({ week: plan.week, today, items: gathered.items });
        const out = await provider.complete(request);
        parsed = parseWaiverPicks(out.text, sources, { numbered: true, notBefore: Date.now() - 7 * 86_400_000 });
        model = out.model;
      }
    }
  } catch (error) {
    return fail(error);
  }

  // Compare with this league: who can actually be added, and who is taken.
  let players: LeaguePlayerRef[];
  let availablePlayers: RosterPlayer[] = [];
  try {
    const [available, teams, rosters] = await Promise.all([
      plan.reader.getFreeAgents(plan.ref, plan.week, 1000, 'owned'),
      plan.reader.getTeams(plan.ref),
      plan.reader.getAllRosters(plan.ref, plan.week),
    ]);
    availablePlayers = available;
    const teamName = new Map(teams.map((t) => [t.teamId, t.name]));
    players = [
      ...available.map((p) => ({
        id: p.platformPlayerId,
        name: p.name,
        position: p.position,
        status: p.pickup ?? ('free-agent' as const),
      })),
      ...[...rosters].flatMap(([teamId, roster]) =>
        roster.map((p) => ({
          id: p.platformPlayerId,
          name: p.name,
          position: p.position,
          status: 'rostered' as const,
          rosteredBy: teamId === String(plan.ref.teamId) ? 'you' : (teamName.get(teamId) ?? `Team ${teamId}`),
        })),
      ),
    ];
  } catch (error) {
    return fail(error);
  }
  const matched = matchPicks(parsed.picks, players);

  // Every available player the gathered articles name, found without the model:
  // it catches the names a local model skips, and cannot invent one.
  const picked = new Set(matched.flatMap((p) => (p.playerId ? [p.playerId] : [])));
  const byId = new Map(availablePlayers.map((p) => [p.platformPlayerId, p]));
  const scanned: MatchedPick[] = [...scanMentions(gatheredItems, availablePlayers.map((p) => ({ id: p.platformPlayerId, name: p.name, position: p.position })))]
    .filter(([id]) => !picked.has(id))
    .map(([id, hits]) => {
      const p = byId.get(id)!;
      return {
        name: p.name,
        position: p.position,
        reason: `Named in ${hits.length} waiver wire ${hits.length === 1 ? 'article' : 'articles'} gathered this week.`,
        sources: hits.map((h) => ({ url: h.url, title: `${h.source}: ${h.title}` })),
        playerId: id,
        status: p.pickup ?? 'free-agent',
      };
    })
    .sort((a, b) => b.sources.length - a.sources.length);
  const picks = [...matched, ...scanned];

  writeWebPicks({
    leagueKey: plan.key,
    week: plan.week,
    checkedAt: new Date().toISOString(),
    model,
    method,
    itemsRead,
    sourcesUsed,
    picks,
    rejected: parsed.rejected,
  });

  const available = picks.filter((p) => p.status === 'free-agent' || p.status === 'waivers').length;
  const rostered = picks.filter((p) => p.status === 'rostered').length;
  const message =
    picks.length === 0
      ? itemsRead === 0
        ? `No week ${plan.week} waiver articles were found yet.`
        : `The sources named no one to add for week ${plan.week}.`
      : `${picks.length} ${picks.length === 1 ? 'pick' : 'picks'} found: ${available} available in your league, ${rostered} already rostered.`;
  return { ok: true, message: warnings.length > 0 ? `${message} ${warnings.join(' ')}` : message };
}

/** Remove a week's web picks. */
export async function clearWaiverPicks(key: string, week: number): Promise<void> {
  const plan = await planLineup(key, week).catch(() => null);
  if (plan) clearWebPicks(plan.key, plan.week);
}

function fail(error: unknown): PicksResult {
  const message = error instanceof LlmError ? error.message : error instanceof Error ? error.message : String(error);
  return { ok: false, message };
}
