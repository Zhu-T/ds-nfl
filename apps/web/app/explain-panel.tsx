'use client';

import { useActionState } from 'react';
import { explainLineup, type AiResult } from './ai-actions';

/**
 * Ask a language model to explain the recommendation.
 *
 * Only ever runs when clicked: it may cost money (Claude) or take a while (a
 * local model), and the recommendation above is complete without it.
 */
export function ExplainPanel({
  enabled,
  providerLabel,
  leagueKey,
  week,
}: {
  enabled: boolean;
  providerLabel: string;
  leagueKey: string;
  week: number;
}) {
  const [result, run, pending] = useActionState<AiResult | null, FormData>(
    async () => explainLineup(leagueKey, week),
    null,
  );

  if (!enabled) {
    return (
      <p className="ai__off">
        Want this in plain English? <a href="/connect#ai">Turn on AI explanations</a>.
      </p>
    );
  }

  return (
    <section className="ai" aria-live="polite">
      <form action={run}>
        <button className="btn" type="submit" disabled={pending}>
          {pending ? `Asking ${providerLabel}…` : 'Explain this recommendation'}
        </button>
      </form>

      {result?.ok && (
        <div className="ai__text">
          <p>{result.text}</p>
          <p className="ai__attr">{result.attribution}</p>
        </div>
      )}
      {result && !result.ok && <p className="ai__error">{result.message}</p>}
    </section>
  );
}
