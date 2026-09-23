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
  mode = 'best',
  secondary = false,
}: {
  /** The league this page shows; the lineup is written there and nowhere else. */
  leagueKey: string | null;
  /** The week this page shows; the lineup is written for that week. */
  week: number;
  disabled: boolean;
  disabledReason?: string;
  label: string;
  /** Which lineup to write: the best-projected one, or the upside one; see applyLineup. */
  mode?: 'best' | 'upside';
  /** A quieter button, for the upside lineup beside the main one. */
  secondary?: boolean;
}) {
  const refresh = useRefresh();
  const [result, submit, pending] = useActionState<ApplyResult | null, FormData>(async () => {
    const applied = await applyLineup(leagueKey ?? '', week, mode);
    if (applied.ok) refresh();
    return applied;
  }, null);

  return (
    <div className="apply">
      <form action={submit}>
        <button
          className={secondary ? 'btn' : 'btn btn--primary'}
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
