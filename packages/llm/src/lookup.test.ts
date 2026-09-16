import { describe, it, expect } from 'vitest';
import { LOOKUP_LIMIT, lookUpPlayers, lookupBlock, withLookup, type LookupPlayer } from './lookup.js';
import { checkNumbers } from './guard.js';

const p = (
  name: string,
  position: string,
  owner: string,
  ownerKind: LookupPlayer['ownerKind'],
  projected: number,
  extra: Partial<LookupPlayer> = {},
): LookupPlayer => ({ name, position, proTeam: 'X', owner, ownerKind, projected, ...extra });

const list: LookupPlayer[] = [
  p('Tyler Shough', 'QB', 'Waivers', 'waivers', 16.6, { gain: 0 }),
  p('Devaughn Vele', 'WR', 'Waivers', 'waivers', 8.1, { gain: 0.4 }),
  p('Bijan Robinson', 'RB', 'Ceebee', 'team', 18.2),
  p('Jordan Love', 'QB', 'Swift Love in the Burrow', 'team', 17.9),
  p('Amon-Ra St. Brown', 'WR', "Miguel's Magnificent Team", 'team', 16.4),
  p('Chase Brown', 'RB', 'Likely to Pierce Brown People', 'team', 14),
  p('Kenneth Walker III', 'RB', 'Ceebee', 'team', 12.5),
  p('Panthers D/ST', 'DST', 'Waivers', 'waivers', 6, { gain: 2.7 }),
  p('Matthew Stafford', 'QB', 'Your roster', 'mine', 20.3),
  ...Array.from({ length: 14 }, (_, i) => p(`Spare Back${i}`, 'RB', 'Free agent', 'free-agent', 9 - i * 0.5, { gain: 0 })),
];
const names = (q: string, from: readonly LookupPlayer[] = list) => lookUpPlayers(q, from).map((x) => x.name);

describe('lookUpPlayers', () => {
  it('finds players by surname, full name, or a first name only one player has', () => {
    expect(names('is shough worth a claim?')).toEqual(['Tyler Shough']);
    expect(names('Vele or Walker?')).toEqual(['Devaughn Vele', 'Kenneth Walker III']);
    expect(names('who has bijan')).toEqual(['Bijan Robinson']);
    expect(names('what about Amon-Ra St. Brown')).toEqual(['Amon-Ra St. Brown']);
  });

  it('needs a capital for surnames that are everyday words', () => {
    expect(names('I love this matchup')).toEqual([]);
    expect(names('Should I trade for Love?')).toEqual(['Jordan Love']);
    expect(names('chase brown or vele')).toEqual(['Devaughn Vele', 'Chase Brown']);
  });

  it('finds a defense by its team name, and leaves out your own roster', () => {
    expect(names('are the panthers any good?')).toEqual(['Panthers D/ST']);
    expect(names('why is stafford starting?')).toEqual([]);
  });

  it("lists a named fantasy team's players, at the positions asked about", () => {
    expect(names('what RBs does Ceebee have?')).toEqual(['Bijan Robinson', 'Kenneth Walker III']);
    expect(names("what does Miguel's team have")).toEqual(['Amon-Ra St. Brown']);
  });

  it('lists the best unrostered players at a position asked about', () => {
    const rbs = names('any running backs on waivers?');
    expect(rbs).toHaveLength(10);
    expect(rbs[0]).toBe('Spare Back0');
    expect(names('best available defense?')).toEqual(['Panthers D/ST']);
  });

  it('attaches at most a fixed number of rows', () => {
    const big = Array.from({ length: 45 }, (_, i) => p(`Deep Player${i}`, 'WR', 'Ceebee', 'team', i));
    expect(names('what does ceebee have', big)).toHaveLength(LOOKUP_LIMIT);
  });

  it('writes each row with status, projection, and gain, so the guard accepts quoting them', () => {
    const block = lookupBlock(lookUpPlayers('shough and bijan', list), 'Sep 15, 10:40 AM');
    expect(block.split('\n')).toEqual([
      "Players the app looked up for this question, from the league's player list (updated Sep 15, 10:40 AM). Answer from these rows; for these players they are more complete than the context. Unrostered players' projections include web news and betting lines, as on the Waivers page; other teams' players show ESPN's projection.",
      '',
      'Not on any roster in the league:',
      '- Tyler Shough (QB, X): on waivers, needs a claim; projected 16.6, adds 0.0 to your best lineup',
      '',
      'Rostered by Ceebee:',
      '- Bijan Robinson (RB, X): rostered by Ceebee; projected 18.2',
    ]);
    expect(checkNumbers('Shough projects 16.6 and Bijan projects 18.2.', block).ok).toBe(true);
    expect(lookupBlock([], 'now')).toBe('');
  });

  it('puts the looked-up rows before the question, and leaves a plain question alone', () => {
    expect(withLookup('Who?', '')).toBe('Who?');
    expect(withLookup('Who?', 'ROWS')).toBe('ROWS\n\nQuestion: Who?');
  });
});
