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

const POSITIONS = ['All', 'QB', 'RB', 'WR', 'TE', 'K', 'DST'] as const;
type Who = 'all' | 'available' | 'mine' | 'rostered';
const WHO: readonly { key: Who; label: string }[] = [
  { key: 'all', label: 'Everyone' },
  { key: 'available', label: 'Available' },
  { key: 'mine', label: 'My team' },
  { key: 'rostered', label: 'Other teams' },
];
/** Rows drawn at a time; the rest come with "Show more". */
const PAGE = 50;

function whoMatches(who: Who, kind: OwnerKind): boolean {
  if (who === 'available') return kind === 'waivers' || kind === 'free-agent';
  if (who === 'mine') return kind === 'mine';
  if (who === 'rostered') return kind === 'team';
  return true;
}

/** The Players table: filters and a search box over the rows already loaded, drawn a page at a time. */
export function PlayersTable({ rows }: { rows: readonly PlayerRow[] }) {
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState<(typeof POSITIONS)[number]>('All');
  const [who, setWho] = useState<Who>('all');
  const [limit, setLimit] = useState(PAGE);
  const deferred = useDeferredValue(query);
  const matching = useMemo(
    () =>
      searchPlayers(
        rows.filter((r) => (position === 'All' || r.position === position) && whoMatches(who, r.ownerKind)),
        deferred,
      ),
    [rows, deferred, position, who],
  );
  const shown = matching.slice(0, limit);
  const filtered = deferred.trim() !== '' || position !== 'All' || who !== 'all';
  const reset = () => setLimit(PAGE);

  return (
    <>
      <div className="players-search">
        <input
          type="search"
          className="field__input"
          placeholder="Search by name, position, NFL team, or owner"
          aria-label="Search players"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            reset();
          }}
          autoComplete="off"
          spellCheck={false}
        />
        <span className="field__hint" aria-live="polite">
          {filtered ? `${matching.length} of ${rows.length} players` : `${rows.length} players`}
        </span>
      </div>

      <div className="sortbar" role="group" aria-label="Filter players">
        {POSITIONS.map((p) => (
          <button
            key={p}
            type="button"
            className={`chip${position === p ? ' chip--on' : ''}`}
            aria-pressed={position === p}
            onClick={() => {
              setPosition(p);
              reset();
            }}
          >
            {p}
          </button>
        ))}
        <span className="sortbar__gap" />
        {WHO.map((w) => (
          <button
            key={w.key}
            type="button"
            className={`chip${who === w.key ? ' chip--on' : ''}`}
            aria-pressed={who === w.key}
            onClick={() => {
              setWho(w.key);
              reset();
            }}
          >
            {w.label}
          </button>
        ))}
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
                  No player matches{deferred.trim() ? <> &ldquo;{deferred.trim()}&rdquo;</> : ' these filters'}. The list holds
                  every rostered player and the top unrostered ones.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {matching.length > shown.length && (
        <div className="showmore">
          <button type="button" className="btn btn--ghost" onClick={() => setLimit((n) => n + PAGE)}>
            Show {Math.min(PAGE, matching.length - shown.length)} more
          </button>
          <span className="field__hint">
            {shown.length} of {matching.length} shown
          </span>
        </div>
      )}
    </>
  );
}
