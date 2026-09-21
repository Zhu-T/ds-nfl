'use client';

import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import { RENDER_STAMP_ID } from './render-stamp';

/** How long a refresh gets to land before the page is loaded afresh. One that works takes well under a second. */
const FALLBACK_MS = 2000;

/**
 * Reload the page's server data after an action that changed it.
 *
 * An action that calls `revalidatePath` sends the refreshed page back in its
 * own response, but in production builds React only sometimes applies it. In
 * testing, ignoring a news finding saved at once and the response carried the
 * updated page, yet the screen stayed as it was for over a minute; navigating
 * away and back always showed the change. So the actions do not call
 * `revalidatePath` (every page here is dynamic and nothing is cached on the
 * server, so that response was its only effect), and every action that changes
 * what a page shows ends with a refresh instead.
 *
 * Even that refresh went missing in 4 of 16 production runs, with the action
 * finished and its change saved. So the root layout stamps each render (see
 * render-stamp.ts), and a refresh that has not changed the stamp after two
 * seconds is redone as a full page load, which has never failed to show it.
 */
export function useRefresh(): () => void {
  const router = useRouter();
  return useCallback(() => {
    const stamp = () => document.getElementById(RENDER_STAMP_ID)?.dataset['at'];
    const before = stamp();
    router.refresh();
    window.setTimeout(() => {
      if (stamp() === before) window.location.reload();
    }, FALLBACK_MS);
  }, [router]);
}
