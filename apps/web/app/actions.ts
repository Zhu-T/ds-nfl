'use server';

import type { LineupSlot } from '@ds-nfl/core';
import { AdapterFailure, EspnWriter, describeError, type DesiredSlot } from '@ds-nfl/adapters';
import { planLineup } from '@/lib/week';
import { upsideLineup } from '@/lib/upside';

export interface ApplyResult {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * Push the optimizer's lineup to the platform.
 *
 * The lineup is recomputed here rather than trusted from the client: a form post
 * is not a safe source of truth for what to write to someone's roster, and the
 * roster may have changed since the page was rendered. It is recomputed by the
 * same function the page used, for the league and week the page showed, with
 * the same web news adjustments — so what is written is what was shown.
 */
/**
 * `mode` picks which lineup: "best", the best-projected one the page leads with,
 * or "upside", the one with the best chance of winning this week's matchup,
 * shown only when its switch is on. Either is recomputed here.
 */
export async function applyLineup(key: string, week: number, mode: 'best' | 'upside' = 'best'): Promise<ApplyResult> {
  const gone = { ok: false, message: 'That league is no longer connected. Reload the page.' };
  if (!key) return gone;

  try {
    const plan = await planLineup(key, week);
    if (!plan) return gone;

    // Target slot per player: a starting slot if the optimizer seats them,
    // otherwise the bench.
    const chosen = mode === 'upside' ? (await upsideLineup(plan))?.solution : plan.optimal;
    if (!chosen) return { ok: false, message: 'There is no matchup this week to play for, so there is no upside lineup.' };
    const target = new Map<string, LineupSlot>();
    for (const p of plan.roster) target.set(p.platformPlayerId, 'BENCH');
    for (const s of chosen.starters) {
      if (s.player) target.set(s.player.gsisId, s.slot);
    }

    const changes: DesiredSlot[] = plan.roster
      .filter((p) => p.currentSlot !== 'IR' && target.get(p.platformPlayerId) !== p.currentSlot)
      .map((p) => ({
        platformPlayerId: p.platformPlayerId,
        name: p.name,
        fromSlot: p.currentSlot,
        toSlot: target.get(p.platformPlayerId) ?? 'BENCH',
        // Nothing is locked in a week that has not started.
        locked: p.locked && !plan.isFuture,
      }));

    if (changes.length === 0) {
      return {
        ok: true,
        message:
          mode === 'upside'
            ? `Your week ${plan.week} lineup is already the upside lineup — nothing to change.`
            : `Your week ${plan.week} lineup is already optimal — nothing to change.`,
      };
    }

    const writer = new EspnWriter({ espnS2: plan.conn.espnS2, swid: plan.conn.swid }, (r, w) =>
      plan.reader.getSlotMap(r, w),
    );
    const result = await writer.setLineup(plan.ref, plan.week, changes);

    const moved = result.moved.map((m) => `${m.name} → ${m.to}`).join(', ');
    return { ok: true, message: `Week ${plan.week} lineup set and confirmed on ESPN: ${moved}.` };
  } catch (e) {
    const message =
      e instanceof AdapterFailure
        ? describeError(e.error)
        : e instanceof Error
          ? e.message
          : String(e);
    return { ok: false, message };
  }
}
