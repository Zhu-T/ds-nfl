'use server';

import { checkNumbers, tradeOfferFacts, tradeOfferRequest } from '@ds-nfl/llm';
import { loadPending } from '@/lib/league-data';
import { aiStatus, currentProvider } from '@/lib/ai';

export interface AdviceResult {
  readonly ok: boolean;
  readonly message: string;
  /** The model's answer, when it passed the number check. */
  readonly text?: string;
  readonly reasoning?: string;
}

/**
 * Whether to take a trade someone has offered you.
 *
 * The app values both sides; the model only argues from those numbers, and any
 * answer containing a number the app did not produce is withheld, as everywhere
 * else. Runs only when asked: it costs a request.
 */
export async function tradeAdviceAction(key: string, tradeId: string): Promise<AdviceResult> {
  // The judgment model, as the news check and waiver picks use.
  const provider = currentProvider('judgment');
  const label = aiStatus().judgmentLabel ?? 'The model';
  if (!provider) {
    return { ok: false, message: 'Reading a trade offer needs an AI provider. Turn one on under Settings.' };
  }

  const pending = await loadPending(key);
  if (pending.state !== 'ok') {
    return { ok: false, message: pending.state === 'error' ? pending.message : 'No league is connected.' };
  }
  const offer = pending.data.pending.find((p) => p.id === tradeId);
  if (!offer?.trade) {
    return { ok: false, message: 'That offer is no longer on the table. Reload the page.' };
  }

  const t = offer.trade;
  const facts = tradeOfferFacts({
    week: offer.week,
    myTeam: 'your team',
    theirTeam: t.otherTeam,
    incoming: t.incoming,
    outgoing: t.outgoing,
    myThisWeek: t.myThisWeek,
    myTotal: t.myTotal,
    weeks: t.weeks.length > 1 ? `weeks ${t.weeks[0]}-${t.weeks.at(-1)}` : `week ${t.weeks[0]}`,
    theirThisWeek: t.theirThisWeek,
    depth: t.depth,
  });

  try {
    const answer = await provider.complete(tradeOfferRequest(facts));
    const checked = checkNumbers(answer.text, facts);
    if (!checked.ok) {
      return {
        ok: false,
        message: `${label} used a number the app did not produce (${checked.invented.join(', ')}), so the answer is withheld. The values above stand on their own.`,
      };
    }
    return {
      ok: true,
      message: `${label} read the offer.`,
      text: answer.text,
      ...(answer.reasoning ? { reasoning: answer.reasoning } : {}),
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
