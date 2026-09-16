/**
 * Injured lead teammates, from the players a page has loaded: who is next in
 * line at their position when the player their NFL team leans on is out.
 */

import type { RosterPlayer } from '@ds-nfl/adapters';
import { openedRoles, type OpenedRole } from '@ds-nfl/core';

export function openingsAmong(players: readonly RosterPlayer[]): Map<string, OpenedRole> {
  return openedRoles(
    players.map((p) => ({
      id: p.platformPlayerId,
      name: p.name,
      position: p.position,
      proTeam: p.proTeam,
      percentOwned: p.percentOwned,
      injury: p.unavailableReason,
    })),
  );
}
