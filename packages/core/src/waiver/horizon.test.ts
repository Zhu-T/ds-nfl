import { describe, it, expect } from 'vitest';
import { dropCosts, horizonValues, swapValue, tradeValue, type Horizon, type Outlook } from './horizon.js';
import { rankWaiverCandidates } from './evaluate.js';
import type { OptimizerPlayer } from '../lineup/optimize.js';
import type { RosterSettings } from '../types.js';

function p(name: string, position: OptimizerPlayer['position'], pts: number, extra: Partial<OptimizerPlayer> = {}): OptimizerPlayer {
  return { gsisId: name, name, position, projectedPoints: pts, available: true, ...extra };
}

const rs: RosterSettings = { slots: { QB: 1, RB: 1, WR: 1, FLEX: 1 }, benchSize: 7, irSize: 0 };

// One quarterback slot and three quarterbacks: two of them never start. RB1 is on bye in week 4.
const roster = [
  p('QB1', 'QB', 20),
  p('QB2', 'QB', 18),
  p('QB3', 'QB', 17),
  p('RB1', 'RB', 15),
  p('RB2', 'RB', 10),
  p('WR1', 'WR', 14),
  p('WR2', 'WR', 9),
];

function horizonFor(players: readonly OptimizerPlayer[], extra: Record<string, Partial<Outlook>> = {}): Horizon {
  const outlooks = new Map<string, Outlook>();
  for (const x of players) {
    outlooks.set(x.gsisId, { perGame: x.projectedPoints, offWeeks: new Set<number>(), ...extra[x.gsisId] });
  }
  return { weeks: [2, 3, 4, 5], outlooks };
}

describe('dropCosts', () => {
  it('suggests the surplus backup quarterback, not the lowest-projected bench player', () => {
    const horizon = horizonFor(roster, { RB1: { offWeeks: new Set([4]) } });
    const costs = dropCosts(roster, horizon, rs, new Set(roster.map((x) => x.gsisId)));
    // WR2 projects least, but he fills the flex in RB1's bye week; the backup quarterbacks never start.
    expect(costs.map((c) => [c.name, c.total])).toEqual([
      ['QB3', 0],
      ['QB2', 0],
      ['QB1', 8],
      ['WR2', 9],
      ['RB2', 13],
      ['RB1', 18],
      ['WR1', 29],
    ]);
    expect(costs.find((c) => c.name === 'WR2')!.byWeek).toEqual([0, 0, 9, 0]);
  });

  it('among free drops, cuts from the position with the most spare players first', () => {
    const rsWithTe: RosterSettings = { slots: { QB: 1, RB: 1, WR: 1, TE: 1, FLEX: 1 }, benchSize: 9, irSize: 0 };
    const deeper = [...roster, p('TE1', 'TE', 8), p('TE2', 'TE', 4)];
    const costs = dropCosts(deeper, horizonFor(deeper), rsWithTe, new Set(deeper.map((x) => x.gsisId)));
    // Four players cost nothing. Two spare quarterbacks go before the backup tight end
    // and the backup receiver, though both of those project lower.
    expect(costs.slice(0, 4).map((c) => [c.name, c.total])).toEqual([
      ['QB3', 0],
      ['QB2', 0],
      ['TE2', 0],
      ['WR2', 0],
    ]);
  });

  it('weighs spare players against how many start at the position', () => {
    const twoReceivers: RosterSettings = { slots: { QB: 1, RB: 1, WR: 2, FLEX: 1 }, benchSize: 9, irSize: 0 };
    const wide = [...roster, p('WR3', 'WR', 5), p('WR4', 'WR', 4)];
    const costs = dropCosts(wide, horizonFor(wide), twoReceivers, new Set(wide.map((x) => x.gsisId)));
    // Two spare receivers behind two starters, two spare quarterbacks behind one: the quarterbacks go
    // first, though the receivers project lower.
    expect(costs.slice(0, 4).map((c) => c.name)).toEqual(['QB3', 'QB2', 'WR4', 'WR3']);
  });

  it('only considers the players it may drop', () => {
    const horizon = horizonFor(roster);
    expect(dropCosts(roster, horizon, rs, new Set(['WR2', 'RB2'])).map((c) => c.name)).toEqual(['WR2', 'RB2']);
  });
});

describe('horizonValues', () => {
  const rb3 = p('RB3', 'RB', 12);
  const hurtNow = p('RB4', 'RB', 0, { available: false, unavailableReason: 'Out' });
  const qb4 = p('QB4', 'QB', 19);
  const wr3 = p('WR3', 'WR', 11);
  const everyone = [...roster, rb3, hurtNow, qb4, wr3];
  const horizon = horizonFor(everyone, {
    RB1: { offWeeks: new Set([4]) },
    RB4: { perGame: 16 },
    WR3: { offWeeks: new Set([3]) },
  });
  const values = horizonValues(roster, [rb3, hurtNow, qb4, wr3], horizon, rs);

  it('adds up what a candidate adds each week, more in the week he covers a bye', () => {
    expect(values.get('RB3')).toEqual({ total: 9, byWeek: [2, 2, 3, 2] });
  });

  it('values a player who cannot help this week but will from next week', () => {
    expect(values.get('RB4')).toEqual({ total: 19, byWeek: [0, 6, 7, 6] });
  });

  it('gives nothing for a position you are already covered at, and nothing in his own bye week', () => {
    expect(values.get('QB4')).toEqual({ total: 0, byWeek: [0, 0, 0, 0] });
    expect(values.get('WR3')).toEqual({ total: 4, byWeek: [1, 0, 2, 1] });
  });

  it("agrees with the waiver ranking on the first week", () => {
    const ranked = rankWaiverCandidates(roster, [rb3, wr3], rs);
    for (const c of ranked) expect(values.get(c.player.gsisId)!.byWeek[0]).toBe(c.lineupGain);
  });

  it('keeps a player without an outlook at his first-week projection every week', () => {
    const bare: Horizon = { weeks: [2, 3], outlooks: new Map() };
    expect(horizonValues(roster, [rb3], bare, rs).get('RB3')).toEqual({ total: 4, byWeek: [2, 2] });
  });
});

describe('swapValue', () => {
  const horizon = horizonFor([...roster, p('RB3', 'RB', 12), p('WR3', 'WR', 11)], { RB1: { offWeeks: new Set([4]) } });

  it('values a one-for-one swap week by week, more in the week it covers a bye', () => {
    // A bench receiver for a better running back: the flex improves by 2, by 3 in RB1's bye week.
    expect(swapValue(roster, 'WR2', p('RB3', 'RB', 12), horizon, rs)).toEqual({ total: 9, byWeek: [2, 2, 3, 2] });
  });

  it('is negative when the trade hurts', () => {
    const v = swapValue(roster, 'RB1', p('WR3', 'WR', 11), horizon, rs);
    expect(v.byWeek[0]).toBe(-4);
    expect(v.total).toBeLessThan(0);
  });
});
describe('tradeValue', () => {
  const settings: RosterSettings = { slots: { RB: 1, WR: 1 }, benchSize: 4, irSize: 0 };
  const p = (id: string, position: 'RB' | 'WR', pts: number): OptimizerPlayer => ({
    gsisId: id,
    name: id,
    position,
    eligibleSlots: [position],
    projectedPoints: pts,
    available: true,
  });
  it('values two players out for one better one in, across the weeks', () => {
    const roster = [p('rb1', 'RB', 8), p('wr1', 'WR', 9), p('wr2', 'WR', 4)];
    const star = p('star', 'WR', 20);
    const h: Horizon = {
      weeks: [3, 4],
      outlooks: new Map([
        ['rb1', { perGame: 8, offWeeks: new Set<number>() }],
        ['wr1', { perGame: 9, offWeeks: new Set<number>() }],
        ['wr2', { perGame: 4, offWeeks: new Set<number>() }],
        ['star', { perGame: 20, offWeeks: new Set<number>() }],
      ]),
    };
    // Giving up wr1 and wr2 for the star: the lineup gains 11 a week, twice.
    expect(tradeValue(roster, ['wr1', 'wr2'], [star], h, settings)).toEqual({ total: 22, byWeek: [11, 11] });
  });

  it('goes negative when the trade costs you, and counts a bye in the weeks it covers', () => {
    const roster = [p('rb1', 'RB', 8), p('wr1', 'WR', 15)];
    const worse = p('worse', 'WR', 10);
    const h: Horizon = {
      weeks: [3, 4],
      outlooks: new Map([
        ['rb1', { perGame: 10, offWeeks: new Set<number>() }],
        ['wr1', { perGame: 15, offWeeks: new Set<number>() }],
        ['worse', { perGame: 10, offWeeks: new Set([4]) }],
      ]),
    };
    const value = tradeValue(roster, ['wr1'], [worse], h, settings);
    expect(value.byWeek[0]).toBe(-5);
    // Week 4 is their bye: the whole 15 is lost.
    expect(value.byWeek[1]).toBe(-15);
    expect(value.total).toBe(-20);
  });
});
