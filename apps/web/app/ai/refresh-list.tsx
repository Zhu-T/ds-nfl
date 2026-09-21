'use client';

import { useTransition } from 'react';
import { useRefresh } from '@/lib/use-refresh';
import { refreshPlayerList } from './actions';

/** Rebuild the league's player list now, then reload the page to show it. */
export function RefreshListForm({ leagueKey }: { leagueKey: string }) {
  const [pending, start] = useTransition();
  const refresh = useRefresh();
  return (
    <button
      type="button"
      className="btn btn--ghost"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const form = new FormData();
          form.set('league', leagueKey);
          await refreshPlayerList(form);
          refresh();
        })
      }
    >
      {pending ? 'Refreshing…' : 'Refresh the list'}
    </button>
  );
}
