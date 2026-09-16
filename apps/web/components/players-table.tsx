'use client';

import { useDeferredValue, useMemo, useState } from 'react';
import type { OwnerKind, PlayerRow } from '@/lib/league-data';
import { searchPlayers } from '@/lib/player-search';
import { positionHue } from '@/lib/sample-league';
import type { Position } from '@ds-nfl/core';

const OWNER_CLASS: Record<OwnerKind, string> = {
  mine: 'owner owner--mine',
  team: 'owner',
  waivers: 'owner owner--waivers',
  'free-agent': 'owner owner--free',
};

/** The Players table with a search box over the rows already loaded. */
export function PlayersTable({ rows }: { rows: readonly PlayerRow[] }) {
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query);
  const shown = useMemo(() => searchPlayers(rows, deferred), [rows, deferred]);
  const searching = deferred.trim() !== '';

  return (
    <>
      <div className="players-search">
        <input
          type="search"
          className="field__input"
          placeholder="Search by name, position, NFL team, or owner"
          aria-label="Search players"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <span className="field__hint" aria-live="polite">
          {searching ? `${shown.length} of ${rows.length} players` : `${rows.length} players`}
        </span>
      </div>

      <div className="tablewrap">
        <table className="table">
          <thead>
            <tr>
              <th>Player</th>
              <th>Pos</th>
              <th>Team</th>
              <th>Owner</th>
              <th>Status</th>
              <th className="table__num">Proj</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id}>
                <td>
                  <span className="dot" style={{ ['--slot-hue' as string]: positionHue(r.position as Position) }} />
                  {r.name}
                </td>
                <td className="table__dim">{r.position}</td>
                <td className="table__dim">{r.proTeam ?? '—'}</td>
                <td>
                  <span className={OWNER_CLASS[r.ownerKind]}>{r.owner}</span>
                </td>
                <td className="table__dim">{r.note ?? '—'}</td>
                <td className="table__num">{r.projected.toFixed(1)}</td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="table__dim">
                  No player in this list matches &ldquo;{deferred.trim()}&rdquo;. The list holds every rostered
                  player and the top unrostered ones.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
