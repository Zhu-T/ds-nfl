/**
 * ESPN lineup writes.
 *
 * ESPN has no documented write API, but the fantasy web app posts lineup changes
 * to a transactions endpoint, and it works with the same two cookies the reads
 * use. That means no browser automation for this — the previous implementation
 * drove Playwright and still never completed a swap.
 *
 * Two rules this file exists to enforce:
 *
 *   1. A write is not reported as successful until the change is read back from
 *      the platform. `LineupWriteResult` cannot be constructed any other way.
 *      The old code clicked "Save" and logged success unconditionally, which is
 *      how a feature that never worked survived for months.
 *   2. Locked players are rejected before the request is sent, with a message
 *      naming them, rather than letting ESPN return a 409 the user has to decode.
 */

import type { LineupSlot } from '@ds-nfl/core';
import { AdapterFailure, type LeagueRef } from '../types.js';
import type { EspnCredentials } from './adapter.js';

const WRITE_HOST = 'https://lm-api-writes.fantasy.espn.com';

/** Our canonical slots back to ESPN's lineupSlotId. */
const SLOT_ID_BY_NAME: Readonly<Record<string, number>> = {
  QB: 0,
  RB: 2,
  WR: 4,
  TE: 6,
  OP: 7,
  DST: 16,
  K: 17,
  BENCH: 20,
  IR: 21,
  FLEX: 23,
  RB_WR: 24,
  WR_TE: 25,
};

export interface DesiredSlot {
  readonly platformPlayerId: string;
  readonly name: string;
  readonly fromSlot: LineupSlot;
  readonly toSlot: LineupSlot;
  readonly locked: boolean;
}

export interface LineupWriteResult {
  /** Proof: the roster was re-read after the write and matched. */
  readonly verifiedBy: 'readback';
  readonly moved: readonly { playerId: string; name: string; to: LineupSlot }[];
}

export class EspnWriter {
  constructor(
    private readonly creds: EspnCredentials,
    /** Injected so the write can be verified against a real read. */
    private readonly readSlots: (ref: LeagueRef, week: number) => Promise<Map<string, LineupSlot>>,
  ) {}

  /**
   * Apply a set of slot changes for one week.
   *
   * `changes` should contain only players whose slot actually differs; a no-op
   * request is rejected by ESPN rather than silently ignored.
   */
  async setLineup(
    ref: LeagueRef,
    week: number,
    changes: readonly DesiredSlot[],
  ): Promise<LineupWriteResult> {
    if (changes.length === 0) {
      throw new AdapterFailure({
        kind: 'not-supported',
        capability: 'setLineup',
        reason: 'There is nothing to change.',
      });
    }

    const locked = changes.filter((c) => c.locked);
    if (locked.length > 0) {
      throw new AdapterFailure({
        kind: 'not-supported',
        capability: 'setLineup',
        reason: `${locked
          .map((c) => c.name)
          .join(', ')} ${locked.length === 1 ? 'is' : 'are'} locked — their game has started, so ESPN will not accept the move.`,
      });
    }

    const items = changes.map((c) => ({
      playerId: Number(c.platformPlayerId),
      type: 'LINEUP',
      fromLineupSlotId: slotId(c.fromSlot),
      toLineupSlotId: slotId(c.toSlot),
    }));

    const url = `${WRITE_HOST}/apis/v3/games/ffl/seasons/${ref.season}/segments/0/leagues/${ref.leagueId}/transactions/`;
    const body = {
      isLeagueManager: false,
      teamId: Number(ref.teamId),
      type: 'ROSTER',
      memberId: this.creds.swid,
      scoringPeriodId: week,
      executionType: 'EXECUTE',
      items,
    };

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `espn_s2=${this.creds.espnS2}; SWID=${this.creds.swid}`,
          'x-fantasy-platform': 'espn-fantasy-web',
          'x-fantasy-source': 'kona',
          'User-Agent': 'Mozilla/5.0',
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new AdapterFailure({
        kind: 'network',
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }

    if (res.status === 401 || res.status === 403) {
      throw new AdapterFailure({
        kind: 'auth-required',
        platform: 'espn',
        hint: 'Sign in to ESPN again and paste fresh cookies on the Connect page.',
      });
    }
    if (!res.ok) {
      // ESPN's own message is far more useful than anything we could invent
      // ("... is locked", "... is not eligible for that slot"), so surface it.
      const text = await res.text().catch(() => '');
      throw new AdapterFailure({
        kind: 'upstream',
        status: res.status,
        url,
        body: espnMessage(text) ?? text,
      });
    }

    // Nothing is reported as done until the platform agrees it is done.
    const after = await this.readSlots(ref, week);
    const wrong = changes.filter((c) => after.get(c.platformPlayerId) !== c.toSlot);
    if (wrong.length > 0) {
      throw new AdapterFailure({
        kind: 'shape-changed',
        expected: `${wrong.map((c) => `${c.name} in ${c.toSlot}`).join(', ')} after the write`,
        url,
      });
    }

    return {
      verifiedBy: 'readback',
      moved: changes.map((c) => ({ playerId: c.platformPlayerId, name: c.name, to: c.toSlot })),
    };
  }

  /**
   * Add a player, drop one, or both at once.
   *
   * A free agent is added immediately and, like a lineup write, is only reported
   * as done once the roster reads back with them on it. A waiver claim is a
   * request ESPN processes later, so it is reported as submitted and never as
   * done; whether it succeeds is not known until the waiver run.
   *
   * The request shape follows the lineup write, which is proven, but ESPN
   * documents none of this: `dryRun` builds the request and returns it without
   * sending, so it can be inspected before anything touches a real roster.
   */
  async addDrop(ref: LeagueRef, week: number, request: AddDropRequest): Promise<AddDropResult> {
    if (!request.add && !request.drop) {
      throw new AdapterFailure({ kind: 'not-supported', capability: 'addDrop', reason: 'There is nothing to add or drop.' });
    }
    const items = [
      ...(request.add
        ? [{ playerId: Number(request.add.platformPlayerId), type: 'ADD', toLineupSlotId: slotId(request.add.toSlot) }]
        : []),
      ...(request.drop
        ? [{ playerId: Number(request.drop.platformPlayerId), type: 'DROP', fromLineupSlotId: slotId(request.drop.fromSlot) }]
        : []),
    ];
    const claim = request.kind === 'waivers';
    const url = `${WRITE_HOST}/apis/v3/games/ffl/seasons/${ref.season}/segments/0/leagues/${ref.leagueId}/transactions/`;
    const body = {
      isLeagueManager: false,
      teamId: Number(ref.teamId),
      type: claim ? 'WAIVER' : 'FREEAGENT',
      memberId: this.creds.swid,
      scoringPeriodId: week,
      executionType: 'EXECUTE',
      ...(claim && request.bid !== undefined ? { bidAmount: request.bid } : {}),
      items,
    };
    const describe = `${request.add ? `add ${request.add.name}` : ''}${request.add && request.drop ? ', ' : ''}${
      request.drop ? `drop ${request.drop.name}` : ''
    }`;

    if (request.dryRun) {
      return { state: 'not-sent', message: `Not sent (dry run): ${describe}.`, request: { url, body } };
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `espn_s2=${this.creds.espnS2}; SWID=${this.creds.swid}`,
          'x-fantasy-platform': 'espn-fantasy-web',
          'x-fantasy-source': 'kona',
          'User-Agent': 'Mozilla/5.0',
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new AdapterFailure({ kind: 'network', message: cause instanceof Error ? cause.message : String(cause) });
    }

    if (res.status === 401 || res.status === 403) {
      throw new AdapterFailure({
        kind: 'auth-required',
        platform: 'espn',
        hint: 'Sign in to ESPN again and paste fresh cookies on the Settings page.',
      });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AdapterFailure({ kind: 'upstream', status: res.status, url, body: espnMessage(text) ?? text });
    }

    // A claim is only queued, so there is nothing to read back yet.
    if (claim) {
      return {
        state: 'submitted',
        message: `Waiver claim submitted: ${describe}${request.bid !== undefined ? ` for $${request.bid}` : ''}. ESPN processes it at the next waiver run.`,
      };
    }

    const after = await this.readSlots(ref, week);
    const added = request.add ? after.has(request.add.platformPlayerId) : true;
    const dropped = request.drop ? !after.has(request.drop.platformPlayerId) : true;
    if (!added || !dropped) {
      throw new AdapterFailure({ kind: 'shape-changed', expected: `${describe} on the roster afterwards`, url });
    }
    return { state: 'done', message: `Done and confirmed on ESPN: ${describe}.` };
  }
}

export interface AddDropRequest {
  /** The player to add, and the slot to put them in (usually the bench). */
  readonly add?: { readonly platformPlayerId: string; readonly name: string; readonly toSlot: LineupSlot };
  readonly drop?: { readonly platformPlayerId: string; readonly name: string; readonly fromSlot: LineupSlot };
  /** A free agent goes through at once; a waiver player needs a claim. */
  readonly kind: 'free-agent' | 'waivers';
  /** The FAAB bid, in leagues with a budget. */
  readonly bid?: number;
  /** Build the request and return it unsent. */
  readonly dryRun?: boolean;
}

export interface AddDropResult {
  /** "done" is read back from the roster; "submitted" is a claim ESPN has queued. */
  readonly state: 'done' | 'submitted' | 'not-sent';
  readonly message: string;
  /** Only for a dry run: exactly what would have been sent. */
  readonly request?: { readonly url: string; readonly body: unknown };
}

function slotId(slot: LineupSlot): number {
  const id = SLOT_ID_BY_NAME[slot];
  if (id === undefined) throw new Error(`No ESPN lineupSlotId for slot ${slot}`);
  return id;
}

/** Pull the human-readable line out of ESPN's error envelope. */
export function espnMessage(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { messages?: unknown };
    const first = Array.isArray(parsed.messages) ? parsed.messages[0] : null;
    return typeof first === 'string' ? first : null;
  } catch {
    return null;
  }
}
