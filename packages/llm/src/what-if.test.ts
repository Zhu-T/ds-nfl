import { describe, it, expect } from 'vitest';
import { whatIfBlock, type WhatIfRow } from './what-if.js';
import { checkNumbers } from './guard.js';

const rows: WhatIfRow[] = [
  { kind: 'add', name: 'KC Concepcion', position: 'WR', pickup: 'waivers', thisWeek: 0, ahead: 1.2, drop: { name: 'Trevor Lawrence', cost: 0 } },
  {
    kind: 'acquire',
    name: 'Chase Brown',
    position: 'RB',
    owner: 'Likely to Pierce Brown People',
    thisWeek: 2.1,
    ahead: 6.3,
    bestTrade: { give: 'Kenny Gainwell', myGain: 2.1, theirGain: 0.4 },
  },
  { kind: 'drop', name: 'Bo Nix', position: 'QB', thisWeek: 0, ahead: 0.3 },
  { kind: 'trade', give: 'Davante Adams', get: 'Chase Brown', owner: 'Likely to Pierce Brown People', mine: 1.5, mineAhead: 4.2, theirs: -2.3 },
];

describe('whatIfBlock', () => {
  it('writes each computed move with this week and the coming weeks', () => {
    expect(whatIfBlock(rows, 'through week 5').split('\n').slice(1)).toEqual([
      '- Add KC Concepcion (WR, on waivers, needs a claim): +0.0 this week, +1.2 through week 5; the player your lineups would miss least is Trevor Lawrence, who costs 0.0 through week 5.',
      '- Get Chase Brown (RB, from Likely to Pierce Brown People): +2.1 this week and +6.3 through week 5 if they were yours; the best one-for-one trade the app finds gives Kenny Gainwell (your lineup +2.1, theirs +0.4 this week).',
      '- Drop Bo Nix (QB, yours): costs 0.0 this week and 0.3 through week 5.',
      '- Trade Davante Adams for Chase Brown (Likely to Pierce Brown People): your best lineup +1.5 this week and +4.2 through week 5; theirs -2.3 this week, so they have little reason to accept.',
    ]);
  });

  it('tells the model to reason from the rows, and the guard accepts quoting them', () => {
    const block = whatIfBlock(rows, 'through week 5');
    expect(block.split('\n')[0]).toContain('do not total lineups yourself');
    expect(checkNumbers('Adding Concepcion gains 1.2; the trade costs them 2.3.', block).ok).toBe(true);
    expect(whatIfBlock([], 'through week 5')).toBe('');
  });
});
