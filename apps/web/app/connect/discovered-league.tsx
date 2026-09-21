'use client';

import { useActionState } from 'react';
import { connectEspn, type ConnectResult } from './actions';
import { useRefresh } from '@/lib/use-refresh';

/** One-click add for a league found on the signed-in ESPN account. */
export function DiscoveredLeague({
  leagueId,
  teamId,
  season,
}: {
  leagueId: string;
  teamId: string;
  season: number;
}) {
  const refresh = useRefresh();
  const [result, submit, pending] = useActionState<ConnectResult | null, FormData>(async (previous, form) => {
    const added = await connectEspn(previous, form);
    if (added?.ok) refresh();
    return added;
  }, null);

  return (
    <form action={submit} className="league-row__actions">
      <input type="hidden" name="leagueId" value={leagueId} />
      <input type="hidden" name="teamId" value={teamId} />
      <input type="hidden" name="season" value={season} />
      <button className="btn btn--primary" type="submit" disabled={pending}>
        {pending ? 'Checking…' : 'Add'}
      </button>
      {result && !result.ok && <span className="ai__error">{result.message}</span>}
    </form>
  );
}
