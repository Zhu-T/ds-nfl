'use client';

import { useActionState } from 'react';
import { applyLineup, type ApplyResult } from './actions';
import { useRefresh } from '@/lib/use-refresh';

export function ApplyButton({
  leagueKey,
  week,
  disabled,
  disabledReason,
  label,
}: {
  /** The league this page shows; the lineup is written there and nowhere else. */
  leagueKey: string | null;
  /** The week this page shows; the lineup is written for that week. */
  week: number;
  disabled: boolean;
  disabledReason?: string;
  label: string;
}) {
  const refresh = useRefresh();
  const [result, submit, pending] = useActionState<ApplyResult | null, FormData>(async () => {
    const applied = await applyLineup(leagueKey ?? '', week);
    if (applied.ok) refresh();
    return applied;
  }, null);

  return (
    <div className="apply">
      <form action={submit}>
        <button
          className="btn btn--primary"
          type="submit"
          disabled={disabled || pending}
          {...(disabled && disabledReason ? { title: disabledReason } : {})}
        >
          {pending ? 'Setting lineup…' : label}
        </button>
      </form>

      {result && (
        <p className={`apply__result${result.ok ? '' : ' apply__result--error'}`} role="status">
          {result.message}
        </p>
      )}
    </div>
  );
}
