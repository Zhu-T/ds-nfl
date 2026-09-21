'use client';

import { useTransition } from 'react';
import { useRefresh } from '@/lib/use-refresh';
import type { LeagueSummary } from '@ds-nfl/adapters';
import { switchLeague } from '@/app/league-actions';

const label = (l: LeagueSummary) => `${l.leagueName}${l.teamName ? ` · ${l.teamName}` : ''}`;

/** Which league every page shows. A plain label until a second league is connected. */
export function LeagueSwitcher({ leagues }: { leagues: readonly LeagueSummary[] }) {
  const [pending, start] = useTransition();
  const refresh = useRefresh();
  if (leagues.length === 0) return null;
  const active = leagues.find((l) => l.active) ?? leagues[0]!;

  return (
    <div className="rail__group rail__league">
      <span className="rail__eyebrow">{leagues.length > 1 ? 'Active league' : 'League'}</span>
      {leagues.length > 1 ? (
        <select
          // Keyed on the active league so the control resets to the truth after a switch.
          key={active.key}
          className="field__input rail__select"
          defaultValue={active.key}
          disabled={pending}
          aria-label="Active league"
          onChange={(e) => {
            const key = e.target.value;
            start(async () => {
              await switchLeague(key);
              refresh();
            });
          }}
        >
          {leagues.map((l) => (
            <option key={l.key} value={l.key}>
              {label(l)} ({l.season})
            </option>
          ))}
        </select>
      ) : (
        <span className="rail__league-name">{label(active)}</span>
      )}
      {pending && <span className="rail__hint">Switching…</span>}
    </div>
  );
}
