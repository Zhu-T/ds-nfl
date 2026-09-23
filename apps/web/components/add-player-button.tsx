'use client';

import { useState, useTransition } from 'react';
import { useRefresh } from '@/lib/use-refresh';
import { addDropPlayer, type MoveResult } from '@/app/waivers/move-actions';

export interface DropChoice {
  readonly id: string;
  readonly name: string;
  readonly position: string;
  readonly locked: boolean;
  /** What losing them would cost your lineups across the coming weeks. */
  readonly cost: number;
}

export interface Incoming {
  readonly id: string;
  readonly name: string;
  readonly position: string;
  readonly proTeam: string | null;
  readonly projected: number;
  /** Points added to your lineup this week, and across the coming weeks. */
  readonly gain: number;
  readonly horizonGain: number;
  /** The starter they would take a place from, if any. */
  readonly displaces: string | null;
}

const pts = (n: number) => n.toFixed(1);
const signed = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(1)}`;

/**
 * Adding a player, with a confirmation that spells out both sides of the swap:
 * who comes in and what they add, who goes out and what losing them costs, and
 * the net across the coming weeks.
 *
 * Nothing is written until Confirm is pressed, and the action checks it all
 * again on the server. A free agent is added at once; a waiver player is a
 * claim ESPN settles later.
 */
export function AddPlayerButton({
  leagueKey,
  week,
  player,
  pickup,
  drops,
  suggestedDropId,
  faab,
  suggestedBid,
  horizonLabel,
}: {
  leagueKey: string;
  week: number;
  player: Incoming;
  pickup: 'free-agent' | 'waivers';
  /** Your players, protected ones already left out. */
  drops: readonly DropChoice[];
  suggestedDropId?: string | undefined;
  /** Null in leagues that use waiver order rather than a budget. */
  faab: { readonly budget: number; readonly remaining: number } | null;
  suggestedBid?: number | undefined;
  /** e.g. "through week 6". */
  horizonLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [dropId, setDropId] = useState(suggestedDropId ?? '');
  const [bid, setBid] = useState(String(suggestedBid ?? 0));
  const [result, setResult] = useState<MoveResult | null>(null);
  const [pending, start] = useTransition();
  const refresh = useRefresh();
  const claim = pickup === 'waivers';
  const drop = drops.find((d) => d.id === dropId);
  const net = player.horizonGain - (drop?.cost ?? 0);
  // Costs within half a point count as a tie, broken by position depth, so the
  // suggested drop is often not the very cheapest. Say so rather than look wrong.
  const cheaper = drop ? drops.filter((d) => d.cost < drop.cost - 0.05 && !d.locked) : [];

  if (result?.ok) return <span className="field__hint">{result.message}</span>;

  if (!open) {
    return (
      <span className="addmove">
        <button type="button" className="btn btn--ghost" onClick={() => setOpen(true)}>
          {claim ? 'Claim' : 'Add'}
        </button>
      </span>
    );
  }

  return (
    <div className="addmove addmove--open">
      <div className="addmove__swap">
        <div className="swap__row swap__in">
          <span className="swap__mark swap__mark--in">IN</span>
          <span className="swap__who">
            {player.name} ({player.position}
            {player.proTeam ? `, ${player.proTeam}` : ''})
          </span>
          <span className="swap__pts">
            {pts(player.projected)} proj · {signed(player.gain)} to your lineup this week ·{' '}
            {signed(player.horizonGain)} {horizonLabel}
            {player.displaces ? ` · would start over ${player.displaces}` : ''}
          </span>
        </div>

        <div className="swap__row swap__out">
          <span className="swap__mark swap__mark--out">OUT</span>
          <span className="swap__who">
            {drop ? `${drop.name} (${drop.position})` : 'Nobody — your roster has room'}
          </span>
          <span className="swap__pts">
            {drop ? `costs ${pts(drop.cost)} ${horizonLabel}` : 'no cost'}
          </span>
        </div>

        <p className="addmove__net">
          Net {signed(net)} {horizonLabel}.{' '}
          {claim
            ? `This is a waiver claim: ESPN settles it at the next waiver run, and someone may claim ${player.name} ahead of you.`
            : `${player.name} is a free agent, so this goes through at once.`}
        </p>

        {cheaper.length > 0 && (
          <p className="addmove__fine">
            {cheaper.length === 1 ? `${cheaper[0]!.name} costs` : `${cheaper.length} others cost`} less over those weeks.
            Costs within half a point count as a tie, broken by the position where you have the most spare players, so a
            third quarterback goes before a fifth receiver.
          </p>
        )}
      </div>

      <div className="addmove__controls">
        <label className="addmove__field">
          Drop
          <select className="field__input" value={dropId} onChange={(e) => setDropId(e.target.value)}>
            <option value="">nobody (roster has room)</option>
            {drops.map((d) => (
              <option key={d.id} value={d.id} disabled={d.locked}>
                {d.name} ({d.position}) — costs {pts(d.cost)}
                {d.locked ? ', locked' : ''}
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
              const answer = await addDropPlayer(leagueKey, week, player.id, dropId || null, claim && faab ? Number(bid) : undefined);
              setResult(answer);
              if (answer.ok) refresh();
            })
          }
        >
          {pending ? 'Sending…' : claim ? `Claim ${player.name}` : `Add ${player.name}`}
        </button>
        <button type="button" className="btn btn--ghost" disabled={pending} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>

      {result && !result.ok && <p className="ai__error">{result.message}</p>}
    </div>
  );
}
