/**
 * Pickups, drops, and trades the app has worked out for one chat question.
 *
 * A model cannot be trusted to add up lineups, and the number guard would
 * withhold any total it worked out itself. So when a question asks about a
 * move involving named players, the app computes it with the same math as the
 * Waivers page (your best lineup with the move minus without it, this week and
 * from this week through the next few) and the model reasons from these rows.
 */

const n = (x: number): string => x.toFixed(1);
const signed = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(1)}`;

export type WhatIfRow =
  | {
      readonly kind: 'add';
      readonly name: string;
      readonly position: string;
      readonly pickup: 'free-agent' | 'waivers';
      readonly thisWeek: number;
      readonly ahead: number;
      /** The player your lineups would miss least, and what losing them costs over the same weeks. */
      readonly drop: { readonly name: string; readonly cost: number } | null;
    }
  | {
      readonly kind: 'acquire';
      readonly name: string;
      readonly position: string;
      readonly owner: string;
      readonly thisWeek: number;
      readonly ahead: number;
      readonly bestTrade: { readonly give: string; readonly myGain: number; readonly theirGain: number } | null;
    }
  | {
      readonly kind: 'drop';
      readonly name: string;
      readonly position: string;
      readonly thisWeek: number;
      readonly ahead: number;
    }
  | {
      readonly kind: 'trade';
      readonly give: string;
      readonly get: string;
      readonly owner: string;
      /** Your best lineup this week, and across the weeks. */
      readonly mine: number;
      readonly mineAhead: number;
      /** Their best lineup this week. */
      readonly theirs: number;
    };

function line(r: WhatIfRow, through: string): string {
  switch (r.kind) {
    case 'add': {
      const how = r.pickup === 'waivers' ? 'on waivers, needs a claim' : 'free agent';
      const drop = r.drop
        ? `; the player your lineups would miss least is ${r.drop.name}, who costs ${n(r.drop.cost)} ${through}`
        : '';
      return `- Add ${r.name} (${r.position}, ${how}): ${signed(r.thisWeek)} this week, ${signed(r.ahead)} ${through}${drop}.`;
    }
    case 'acquire': {
      const trade = r.bestTrade
        ? `; the best one-for-one trade the app finds gives ${r.bestTrade.give} (your lineup ${signed(r.bestTrade.myGain)}, theirs ${signed(r.bestTrade.theirGain)} this week)`
        : '; no one-for-one trade the app finds helps both lineups';
      return `- Get ${r.name} (${r.position}, from ${r.owner}): ${signed(r.thisWeek)} this week and ${signed(r.ahead)} ${through} if they were yours${trade}.`;
    }
    case 'drop':
      return `- Drop ${r.name} (${r.position}, yours): costs ${n(r.thisWeek)} this week and ${n(r.ahead)} ${through}.`;
    case 'trade': {
      const accept = r.theirs <= 0 ? ', so they have little reason to accept' : '';
      return `- Trade ${r.give} for ${r.get} (${r.owner}): your best lineup ${signed(r.mine)} this week and ${signed(r.mineAhead)} ${through}; theirs ${signed(r.theirs)} this week${accept}.`;
    }
  }
}

/** The computed moves as the model reads them; empty when there are none. `through` is e.g. "through week 5". */
export function whatIfBlock(rows: readonly WhatIfRow[], through: string): string {
  if (rows.length === 0) return '';
  return [
    `What the app computed for this question, with the same math as the Waivers page: your best lineup with the move minus without it, this week and from this week ${through}. Reason from these numbers; do not total lineups yourself.`,
    ...rows.map((r) => line(r, through)),
  ].join('\n');
}
