'use server';

import { AdapterFailure, EspnWriter, describeError, protectedIds } from '@ds-nfl/adapters';
import { planLineup } from '@/lib/week';

export interface MoveResult {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * Add a player, dropping one of yours to make room.
 *
 * Everything is checked again here rather than trusted from the page: that the
 * player really is available, that the drop is on your roster and movable, and
 * which league and week this is for. A free agent goes through at once and is
 * read back; a waiver claim is only submitted, and ESPN settles it later.
 *
 * This is only ever reached from the confirmation on the Waivers page. Nothing
 * writes on its own.
 */
export async function addDropPlayer(
  key: string,
  week: number,
  addId: string,
  dropId: string | null,
  bid?: number,
): Promise<MoveResult> {
  if (!key || !addId) return { ok: false, message: 'That league is no longer connected. Reload the page.' };

  try {
    const plan = await planLineup(key, week);
    if (!plan) return { ok: false, message: 'That league is no longer connected. Reload the page.' };

    const [target] = await plan.reader.getPlayersByIds(plan.ref, plan.week, [addId]);
    if (!target) return { ok: false, message: 'That player could not be read from ESPN. Reload the page.' };
    if (!target.pickup) {
      return { ok: false, message: `${target.name} is on a roster now, so they cannot be added.` };
    }

    const drop = dropId ? plan.roster.find((p) => p.platformPlayerId === dropId) : undefined;
    if (dropId && !drop) return { ok: false, message: 'The player to drop is not on your roster any more. Reload the page.' };
    if (drop?.locked && !plan.isFuture) {
      return { ok: false, message: `${drop.name}'s game has started, so ESPN will not let you drop them.` };
    }
    if (drop && protectedIds(plan.key).has(drop.platformPlayerId)) {
      return { ok: false, message: `${drop.name} is protected. Unprotect them on the Waivers page first.` };
    }

    const writer = new EspnWriter({ espnS2: plan.conn.espnS2, swid: plan.conn.swid }, (r, w) => plan.reader.getSlotMap(r, w));
    const result = await writer.addDrop(plan.ref, plan.week, {
      add: { platformPlayerId: target.platformPlayerId, name: target.name, toSlot: 'BENCH' },
      ...(drop ? { drop: { platformPlayerId: drop.platformPlayerId, name: drop.name, fromSlot: drop.currentSlot } } : {}),
      kind: target.pickup,
      ...(target.pickup === 'waivers' && bid !== undefined ? { bid } : {}),
    });
    return { ok: true, message: result.message };
  } catch (e) {
    const message = e instanceof AdapterFailure ? describeError(e.error) : e instanceof Error ? e.message : String(e);
    return { ok: false, message };
  }
}
