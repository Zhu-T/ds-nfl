'use client';

import { useTransition } from 'react';
import { useRefresh } from '@/lib/use-refresh';
import { switchLeague } from '../league-actions';
import { forgetLeague } from './actions';

export function LeagueRowActions({
  leagueKey,
  leagueName,
  active,
}: {
  leagueKey: string;
  leagueName: string;
  active: boolean;
}) {
  const [pending, start] = useTransition();
  const refresh = useRefresh();

  return (
    <div className="league-row__actions">
      {!active && (
        <button
          className="btn btn--ghost"
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              await switchLeague(leagueKey);
              refresh();
            })
          }
        >
          Make active
        </button>
      )}
      <button
        className="btn btn--ghost"
        type="button"
        disabled={pending}
        onClick={() => {
          const ok = window.confirm(
            `Remove ${leagueName}? Its saved cookies are deleted from this computer. Its AI conversation is kept, and you can add the league again at any time.`,
          );
          if (ok)
            start(async () => {
              await forgetLeague(leagueKey);
              refresh();
            });
        }}
      >
        Remove
      </button>
    </div>
  );
}
