'use server';

import { LlmError, newsDigestRequest, parseNewsFindings } from '@ds-nfl/llm';
import {
  evaluatePlayer,
  playerNewsInputs,
  playerWebNews,
  type EvaluationResult,
  type PlayerEvaluation,
  type PlayerWebNews,
} from '@/lib/league-data';
import { aiSettings, currentProvider } from '@/lib/ai';

export type EvaluateResult = { readonly ok: true; readonly result: EvaluationResult } | { readonly ok: false; readonly message: string };

export type WebNewsResult = { readonly ok: true; readonly news: PlayerWebNews } | { readonly ok: false; readonly message: string };

/**
 * Search the web on one player, for the evaluation panel: the last week of
 * news. Read-only, and it changes no projection.
 */
export async function playerWebNewsAction(key: string, week: number, id: string): Promise<WebNewsResult> {
  if (!/^\d{1,12}$/.test(String(id))) return { ok: false, message: 'Evaluate a player first.' };
  const res = await playerWebNews(key, Number.isInteger(week) ? week : null, id, aiSettings().ollamaApiKey);
  if (res.state === 'disconnected') return { ok: false, message: 'That league is no longer connected. Reload the page.' };
  if (res.state === 'error') return { ok: false, message: res.message };
  if (!res.data) return { ok: false, message: 'ESPN has no player with that id.' };
  return { ok: true, news: res.data };
}

export type NewsReadResult =
  | {
      readonly ok: true;
      readonly model: string;
      readonly itemsRead: number;
      /** What the model found that changes the player's outlook; null when nothing does. */
      readonly finding: {
        readonly status: string;
        readonly factor: number;
        readonly summary: string;
        readonly sources: readonly { readonly url: string; readonly title: string }[];
      } | null;
      /** The evaluation again with that finding applied, when there is one. */
      readonly evaluation: PlayerEvaluation | null;
      readonly rejected: readonly string[];
    }
  | { readonly ok: false; readonly message: string };

/**
 * Have the AI read the web news just gathered on one player, with any injured
 * teammate ahead of them, under the news check's rules: a finding must cite
 * what it read and stays within the fixed range for its status. The player is
 * then valued again with it. Nothing is saved; the news check on the lineup
 * page is what applies news everywhere.
 */
export async function playerNewsReadAction(key: string, week: number, id: string): Promise<NewsReadResult> {
  if (!/^\d{1,12}$/.test(String(id))) return { ok: false, message: 'Evaluate a player first.' };
  let provider;
  try {
    provider = currentProvider('judgment');
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
  if (!provider) return { ok: false, message: 'Reading the news needs an AI provider. Turn one on under Settings.' };

  const forWeek = Number.isInteger(week) ? week : null;
  const inputs = await playerNewsInputs(key, forWeek, id, aiSettings().ollamaApiKey);
  if (inputs.state === 'disconnected') return { ok: false, message: 'That league is no longer connected. Reload the page.' };
  if (inputs.state === 'error') return { ok: false, message: inputs.message };
  if (!inputs.data) return { ok: false, message: 'ESPN has no player with that id.' };
  const { leagueName, player, items } = inputs.data;
  if (items.length === 0) {
    return { ok: true, model: provider.model, itemsRead: 0, finding: null, evaluation: null, rejected: [] };
  }

  try {
    const today = new Date().toISOString().slice(0, 10);
    const { request, sources } = newsDigestRequest({ leagueName, week: inputs.data.week, today, players: [player], items });
    const out = await provider.complete(request);
    const parsed = parseNewsFindings(out.text, [player], sources, { numbered: true, notBefore: Date.now() - 7 * 86_400_000 });
    const finding = parsed.findings[0] ?? null;
    let evaluation: PlayerEvaluation | null = null;
    if (finding) {
      const again = await evaluatePlayer(key, inputs.data.week, '', id, [finding]);
      if (again.state === 'ok' && again.data.kind === 'evaluated') evaluation = again.data.evaluation;
    }
    return {
      ok: true,
      model: out.model,
      itemsRead: items.length,
      finding: finding
        ? {
            status: finding.status,
            factor: finding.factor,
            summary: finding.summary,
            sources: finding.sources.map((s) => ({ url: s.url, title: s.title })),
          }
        : null,
      evaluation,
      rejected: parsed.rejected.map((r) => r.reason),
    };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
}

function messageOf(error: unknown): string {
  return error instanceof LlmError ? error.message : error instanceof Error ? error.message : String(error);
}

/**
 * Evaluate one player for the league and week the page shows. Read-only: it
 * reads ESPN and changes nothing.
 */
export async function evaluatePlayerAction(key: string, week: number, query: string, id?: string): Promise<EvaluateResult> {
  const q = String(query ?? '').trim().slice(0, 60);
  if (id !== undefined && !/^\d{1,12}$/.test(id)) return { ok: false, message: 'Pick a player from the list.' };
  if (id === undefined && q.length < 2) return { ok: false, message: 'Type at least two letters of a name.' };
  const res = await evaluatePlayer(key, Number.isInteger(week) ? week : null, q, id);
  if (res.state === 'disconnected') return { ok: false, message: 'That league is no longer connected. Reload the page.' };
  if (res.state === 'error') return { ok: false, message: res.message };
  return { ok: true, result: res.data };
}
