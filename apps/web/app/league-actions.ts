'use server';

import { setActiveLeague } from '@ds-nfl/adapters';

/** Make another connected league the one every page shows. */
export async function switchLeague(key: string): Promise<void> {
  setActiveLeague(key);
}
