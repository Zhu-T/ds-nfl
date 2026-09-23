'use client';

import { useState, useTransition } from 'react';
import { useRefresh } from '@/lib/use-refresh';
import { setPlayerProtected } from '@/app/waivers/protect-actions';

export interface ProtectablePlayer {
  readonly id: string;
  readonly name: string;
  readonly position: string;
  readonly protected: boolean;
}

/**
 * Players marked as never to be dropped. A protected player is skipped when the
 * app names who to cut for a pickup, and refused if something tries to drop
 * them. Nothing here is sent to ESPN.
 */
export function ProtectedPanel({ leagueKey, players }: { leagueKey: string; players: readonly ProtectablePlayer[] }) {
  const [saving, setSaving] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const refresh = useRefresh();
  const count = players.filter((p) => p.protected).length;

  return (
    <section className="webnews" style={{ marginBottom: '1rem' }}>
      <div className="webnews__head">
        <div>
          <h3 className="webnews__title">Protected from drops</h3>
          <p className="field__hint">
            {count === 0
              ? 'Nobody is protected. Click a player to keep the app from ever suggesting them as a drop.'
              : `${count} of your ${players.length} players will never be suggested as a drop, or dropped for a pickup.`}
          </p>
        </div>
      </div>
      <div className="sortbar" style={{ marginTop: '0.6rem', marginBottom: 0 }}>
        {players.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`chip${p.protected ? ' chip--on' : ''}`}
            aria-pressed={p.protected}
            disabled={pending && saving === p.id}
            title={p.protected ? `${p.name} is protected; click to allow dropping them` : `Protect ${p.name} from drops`}
            onClick={() => {
              setSaving(p.id);
              start(async () => {
                const done = await setPlayerProtected(leagueKey, p.id, !p.protected);
                if (done.ok) refresh();
                setSaving(null);
              });
            }}
          >
            {p.protected ? '🔒 ' : ''}
            {p.name} <span className="adjustbar__status">{p.position}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
