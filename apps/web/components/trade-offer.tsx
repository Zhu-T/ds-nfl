'use client';

import { useState, useTransition } from 'react';
import type { PendingRow } from '@/lib/league-data';
import { tradeAdviceAction, type AdviceResult } from '@/app/pending/advice-actions';

const pts = (n: number) => n.toFixed(1);
const signed = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(1)}`;
const side = (players: readonly { name: string; position: string; projected: number }[]) =>
  players.map((p) => `${p.name} (${p.position}, ${pts(p.projected)})`).join(', ') || 'nobody';

/**
 * A trade another manager has offered, with both sides valued, and the model's
 * reading of it on request.
 *
 * Accepting or declining is still done on ESPN: the app has no write path for
 * trades, and would ask before using one.
 */
export function TradeOffer({
  row,
  leagueKey,
  aiEnabled,
  providerLabel,
}: {
  row: PendingRow;
  leagueKey: string;
  aiEnabled: boolean;
  providerLabel: string;
}) {
  const [advice, setAdvice] = useState<AdviceResult | null>(null);
  const [pending, start] = useTransition();
  const t = row.trade;
  if (!t) return null;

  const weeks = t.weeks.length > 1 ? `weeks ${t.weeks[0]}–${t.weeks.at(-1)}` : `week ${t.weeks[0]}`;
  const verdict =
    t.myTotal > 0.5 ? 'you gain' : t.myTotal < -0.5 ? 'you lose' : 'close to even';

  return (
    <div className="offer">
      <div className="swap__row swap__in">
        <span className="swap__mark swap__mark--in">GET</span>
        <span className="swap__who">{side(t.incoming)}</span>
      </div>
      <div className="swap__row swap__out">
        <span className="swap__mark swap__mark--out">GIVE</span>
        <span className="swap__who">{side(t.outgoing)}</span>
      </div>

      <p className="offer__value">
        From {t.otherTeam}. Your best lineup {signed(t.myThisWeek)} in week {row.week}, {signed(t.myTotal)} across {weeks}{' '}
        ({verdict}); theirs {signed(t.theirThisWeek)} this week.
        {t.depth.length > 0 ? ` You would hold ${t.depth.join(' and ')}.` : ''}
      </p>

      {aiEnabled && (
        <button
          type="button"
          className="btn btn--ghost"
          disabled={pending}
          onClick={() => start(async () => setAdvice(await tradeAdviceAction(leagueKey, row.id)))}
        >
          {pending ? `Asking ${providerLabel}…` : advice ? 'Ask again' : `Should I take it? Ask ${providerLabel}`}
        </button>
      )}

      {advice && !advice.ok && <p className="ai__error">{advice.message}</p>}
      {advice?.ok && advice.text && (
        <>
          <p className="offer__advice">{advice.text}</p>
          {advice.reasoning && (
            <details className="fold fold--inline">
              <summary>Show reasoning</summary>
              <p className="news__story">{advice.reasoning}</p>
            </details>
          )}
          <p className="addmove__fine">
            {providerLabel} argues from the numbers above and nothing else; accepting or declining is done on ESPN.
          </p>
        </>
      )}
    </div>
  );
}
