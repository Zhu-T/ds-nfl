'use client';

import { useActionState, useCallback, useTransition, type FormEvent } from 'react';
import { useRefresh } from './use-refresh';

/**
 * A server action for a form, without React's automatic form reset.
 *
 * React 19 resets a form after a function passed to its `action` prop finishes,
 * putting every field back to how it first rendered. On the AI settings form
 * that made a provider saved as "Ollama" snap back to "Off" until the page was
 * reloaded, even though the choice had been saved. Submitting through
 * `onSubmit` skips that reset, so a form shows exactly what the user chose;
 * a form that should clear after saving does so itself.
 *
 * Built-in validation (`required` and so on) still runs first, because the
 * submit event only fires once it passes.
 *
 * With `refresh`, the page's server data is reloaded once the action finishes,
 * for forms whose action changes what the page shows (see `useRefresh`).
 */
export function useFormAction<S>(
  action: (previous: S, form: FormData) => Promise<S>,
  initial: S,
  options: { readonly refresh?: boolean } = {},
): readonly [S, (event: FormEvent<HTMLFormElement>) => void, boolean] {
  const refresh = useRefresh();
  const reloads = options.refresh === true;
  const run = useCallback(
    async (previous: S, form: FormData) => {
      const next = await action(previous, form);
      if (reloads) refresh();
      return next;
    },
    [action, reloads, refresh],
  );
  const [state, dispatch, pending] = useActionState<S, FormData>(
    run as (previous: Awaited<S>, form: FormData) => Promise<S>,
    initial as Awaited<S>,
  );
  const [, startTransition] = useTransition();

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      startTransition(() => dispatch(data));
    },
    [dispatch],
  );

  return [state as S, onSubmit, pending] as const;
}
