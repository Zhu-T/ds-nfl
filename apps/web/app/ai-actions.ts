'use server';

import {
  checkNumbers,
  composePitch,
  explainLineupRequest,
  lineupFacts,
  pitchReasonOk,
  pitchTradeRequest,
  tradeFacts,
  tradeTerms,
  LlmError,
  type LlmProvider,
  type LlmRequest,
  type LlmText,
} from '@ds-nfl/llm';
import { loadWeek } from '@/lib/week';
import { loadTrades } from '@/lib/league-data';
import { currentProvider } from '@/lib/ai';
import { lineupFactsInput } from '@/lib/ai-facts';

export interface AiResult {
  readonly ok: boolean;
  readonly text?: string;
  readonly message?: string;
  readonly attribution?: string;
}

/** Explain the lineup the engine recommends, in the engine's own numbers. */
export async function explainLineup(key: string, forWeek: number): Promise<AiResult> {
  const provider = resolveProvider();
  if (!isProvider(provider)) return provider;

  const week = await loadWeek(key, forWeek);
  if (week.isSample) {
    return { ok: false, message: 'Connect a league first — the sample roster is not worth explaining.' };
  }

  const facts = lineupFacts(lineupFactsInput(week));
  return run(provider, explainLineupRequest(facts), facts);
}

/**
 * Draft a message proposing one of the trade finder's ideas.
 *
 * The form only says *which* trade. Every number is recomputed here from the
 * league, never taken from the browser, and the idea must still be on the
 * board — rosters and projections change between page load and click.
 *
 * The terms (who sends which player) are written by the app, not the model: in
 * live testing a local model reversed the trade in two of six drafts. The model
 * supplies only the reason; see `pitchReasonOk` for what it may say.
 */
export async function pitchTrade(_prev: AiResult | null, form: FormData): Promise<AiResult> {
  const provider = resolveProvider();
  if (!isProvider(provider)) return provider;

  const give = String(form.get('give') ?? '');
  const get = String(form.get('get') ?? '');
  const opponent = String(form.get('opponent') ?? '');

  // The league the trades page was showing, even if another is active now.
  const trades = await loadTrades(String(form.get('league') ?? '') || null, Number(form.get('week')) || null);
  if (trades.state !== 'ok') {
    return { ok: false, message: trades.state === 'error' ? trades.message : 'No league is connected.' };
  }

  const idea = trades.data.ideas.find(
    (t) => t.give === give && t.get === get && t.opponentTeam === opponent,
  );
  if (!idea) {
    return { ok: false, message: 'That trade is no longer on the board. Reload the page for the current list.' };
  }

  const input = {
    week: trades.data.week,
    myTeam: trades.data.myTeam,
    opponentTeam: idea.opponentTeam,
    give: idea.give,
    giveProjected: idea.giveProjected,
    get: idea.get,
    getProjected: idea.getProjected,
    theirGain: idea.theirGain,
  };
  const facts = tradeFacts(input);
  const terms = tradeTerms(input);
  // The player you would get is the one the other manager would give up.
  const theyGiveUp = idea.get;

  let author = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    let out: LlmText;
    try {
      out = await provider.complete(pitchTradeRequest(facts));
    } catch (error) {
      return { ok: false, message: messageOf(error) };
    }
    author = authorOf(out);

    const reason = out.text.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
    if (pitchReasonOk(reason, facts, theyGiveUp)) {
      return {
        ok: true,
        text: composePitch(terms, reason),
        attribution: `Terms written by the app; the reason by ${author}.`,
      };
    }
  }

  // Twice the model's reason named the player they would give up, or cited a
  // number the engine did not produce. The exact terms are still a correct
  // message, so offer those alone.
  return {
    ok: true,
    text: composePitch(terms, null),
    attribution: `${author} mentioned ${theyGiveUp} or used numbers the engine did not produce, so only the exact terms are shown.`,
  };
}

function resolveProvider(): LlmProvider | AiResult {
  try {
    return (
      currentProvider() ?? {
        ok: false,
        message: 'AI explanations are off. Turn them on under Settings.',
      }
    );
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
}

function isProvider(value: LlmProvider | AiResult): value is LlmProvider {
  return 'complete' in value;
}

function authorOf(out: LlmText): string {
  return out.provider === 'claude' ? `Claude (${out.model})` : `${out.model}, running locally`;
}

async function run(provider: LlmProvider, request: LlmRequest, facts: string): Promise<AiResult> {
  try {
    const out = await provider.complete(request);
    const author = authorOf(out);

    // The model is told to use only the engine's numbers; this makes sure it did.
    const guard = checkNumbers(out.text, facts);
    if (!guard.ok) {
      return {
        ok: false,
        message: `${author} wrote numbers the engine did not produce (${guard.invented.join(', ')}), so the text was withheld. Try again.`,
      };
    }

    return { ok: true, text: out.text, attribution: `Written by ${author} from the engine's numbers.` };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
}

function messageOf(error: unknown): string {
  if (error instanceof LlmError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
