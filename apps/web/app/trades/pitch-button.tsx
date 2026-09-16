'use client';

import { useActionState, useState } from 'react';
import { pitchTrade, type AiResult } from '../ai-actions';

/** Draft a message to the other manager. Only runs when clicked. */
export function PitchButton({
  give,
  get,
  opponent,
  providerLabel,
  leagueKey,
  week,
}: {
  leagueKey: string;
  week: number;
  give: string;
  get: string;
  opponent: string;
  providerLabel: string;
}) {
  const [result, run, pending] = useActionState<AiResult | null, FormData>(pitchTrade, null);
  const [copied, setCopied] = useState(false);

  return (
    <div className="pitch" aria-live="polite">
      <form action={run}>
        <input type="hidden" name="give" value={give} />
        <input type="hidden" name="get" value={get} />
        <input type="hidden" name="opponent" value={opponent} />
        <input type="hidden" name="league" value={leagueKey} />
        <input type="hidden" name="week" value={week} />
        <button className="btn btn--ghost" type="submit" disabled={pending}>
          {pending ? `Asking ${providerLabel}…` : result?.ok ? 'Draft another' : 'Draft a message'}
        </button>
      </form>

      {result?.ok && result.text && (
        <>
          <p className="pitch__text">{result.text}</p>
          <div className="pitch__row">
            <button
              className="btn btn--ghost"
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(result.text ?? '').then(() => setCopied(true));
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <span className="ai__attr">
              {result.attribution} Check it against the trade above before sending.
            </span>
          </div>
        </>
      )}
      {result && !result.ok && <p className="ai__error">{result.message}</p>}
    </div>
  );
}
