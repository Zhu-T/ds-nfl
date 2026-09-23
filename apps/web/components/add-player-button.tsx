'use client';

import { useState, useTransition } from 'react';
import { useRefresh } from '@/lib/use-refresh';
import { addDropPlayer, type MoveResult } from '@/app/waivers/move-actions';

export interface DropChoice {
  readonly id: string;
  readonly name: string;
  readonly position: string;
  readonly locked: boolean;
}

/**
 * Adding a player, with a confirmation naming both sides of the move.
 *
 * Nothing is written until Confirm is pressed, and the action checks everything
 * again on the server. A free agent is added at once; a waiver player is a
 * claim ESPN settles later.
 */
export function AddPlayerButton({
  leagueKey,
  week,
  playerId,
  playerName,
  pickup,
  drops,
  suggestedDropId,
  faab,
  suggestedBid,
}: {
  leagueKey: string;
  week: number;
  playerId: string;
  playerName: string;
  pickup: 'free-agent' | 'waivers';
  /** Your players, for choosing who makes room. */
  drops: readonly DropChoice[];
  suggestedDropId?: string | undefined;
  /** Null in leagues that use waiver order rather than a budget. */
  faab: { readonly budget: number; readonly remaining: number } | null;
  suggestedBid?: number | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [dropId, setDropId] = useState(suggestedDropId ?? '');
  const [bid, setBid] = useState(String(suggestedBid ?? 0));
  const [result, setResult] = useState<MoveResult | null>(null);
  const [pending, start] = useTransition();
  const refresh = useRefresh();
  const claim = pickup === 'waivers';

  if (result?.ok) return <span className="field__hint">{result.message}</span>;

  return (
    <span className="addmove">
      {!open ? (
        <button type="button" className="btn btn--ghost" onClick={() => setOpen(true)}>
          {claim ? 'Claim' : 'Add'}
        </button>
      ) : (
        <span className="addmove__confirm">
          <label className="addmove__field">
            Drop
            <select className="field__input" value={dropId} onChange={(e) => setDropId(e.target.value)}>
              <option value="">nobody (roster has room)</option>
              {drops.map((d) => (
                <option key={d.id} value={d.id} disabled={d.locked}>
                  {d.name} ({d.position}){d.locked ? ' — locked' : ''}
                </option>
              ))}
            </select>
          </label>

          {claim && faab && (
            <label className="addmove__field">
              Bid $
              <input
                className="field__input"
                type="number"
                min={0}
                max={faab.remaining}
                value={bid}
                onChange={(e) => setBid(e.target.value)}
              />
              <span className="field__hint">of ${faab.remaining} left</span>
            </label>
          )}

          <button
            type="button"
            className="btn btn--primary"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const answer = await addDropPlayer(
                  leagueKey,
                  week,
                  playerId,
                  dropId || null,
                  claim && faab ? Number(bid) : undefined,
                );
                setResult(answer);
                if (answer.ok) refresh();
              })
            }
          >
            {pending ? 'Sending…' : claim ? `Claim ${playerName}` : `Add ${playerName}`}
          </button>
          <button type="button" className="btn btn--ghost" disabled={pending} onClick={() => setOpen(false)}>
            Cancel
          </button>
        </span>
      )}

      {result && !result.ok && <span className="ai__error">{result.message}</span>}
    </span>
  );
}
