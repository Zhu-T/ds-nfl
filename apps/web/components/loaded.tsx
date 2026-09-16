import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * Renders the two states every league-backed page shares.
 *
 * Neither is an error boundary: "not connected" is a normal state with an
 * obvious next step, and a real failure shows what the platform said rather
 * than a generic apology.
 */
export function LoadState({
  state,
  message,
  children,
}: {
  state: 'ok' | 'disconnected' | 'error';
  message?: string;
  children: ReactNode;
}) {
  if (state === 'disconnected') {
    return (
      <div className="placeholder">
        <h2 className="placeholder__title">No league connected</h2>
        <p style={{ maxWidth: '34rem', margin: '0 auto 1.25rem' }}>
          This page reads your real league, so there is nothing to show yet.
        </p>
        <Link href="/connect" className="btn btn--primary">
          Connect a league
        </Link>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="notice notice--error">
        <span className="notice__tag notice__tag--error">Error</span>
        <span>{message}</span>
      </div>
    );
  }

  return <>{children}</>;
}
