'use client';

import { useFormStatus } from 'react-dom';

/** Submit button for rebuilding the player list, busy while the page reloads it. */
export function RefreshListButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn--ghost" disabled={pending}>
      {pending ? 'Refreshing…' : 'Refresh the list'}
    </button>
  );
}
