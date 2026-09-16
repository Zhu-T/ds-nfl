import { describe, it, expect } from 'vitest';
import { lineupFacts, tradeFacts, type LineupFactsInput } from './facts.js';
import { checkNumbers } from './guard.js';

const base: LineupFactsInput = {
  leagueName: "2026 Tommy's League",
  format: '12-team · 0.5 PPR',
  week: 1,
  currentPoints: 100.3,
  optimizedPoints: 101.2,
  pointsGained: 0.9,
  moves: [
    {
      slot: 'WR',
      outName: 'Deebo Samuel Sr.',
      outProjected: 7.4,
      inName: 'Michael Wilson',
      inPosition: 'WR',
      inProjected: 8.3,
    },
  ],
  lockedPlayers: [],
  flagged: [],
  matchup: { opponent: 'Joan of Yard', opponentProjected: 104.4, marginNow: -4.1, marginAfter: -3.2 },
};

describe('lineupFacts', () => {
  it('states each swap with both projections and the difference', () => {
    const facts = lineupFacts(base);
    expect(facts).toContain('start Michael Wilson (WR, projected 8.3) in place of Deebo Samuel Sr. (projected 7.4), a difference of 0.9');
  });

  it('gives the matchup with signed margins', () => {
    const facts = lineupFacts(base);
    expect(facts).toContain('against Joan of Yard, who project 104.4');
    expect(facts).toContain('Margin with the current lineup: -4.1');
    expect(facts).toContain('Margin after the changes: -3.2');
  });

  it('says plainly when there is nothing to change', () => {
    expect(lineupFacts({ ...base, moves: [] })).toContain('Recommended changes: none.');
  });

  it('lists locked players and injury designations when present', () => {
    const facts = lineupFacts({
      ...base,
      lockedPlayers: ['Jonathan Taylor', 'Kyren Williams'],
      flagged: [{ name: 'Kyle Pitts Sr.', note: 'Questionable' }],
    });
    expect(facts).toContain('cannot be moved: Jonathan Taylor, Kyren Williams.');
    expect(facts).toContain('Kyle Pitts Sr. (Questionable)');
  });

  it('describes a fill of an empty slot without inventing an outgoing player', () => {
    const facts = lineupFacts({
      ...base,
      moves: [{ slot: 'K', outName: null, outProjected: null, inName: 'Butker', inPosition: 'K', inProjected: 8.5 }],
    });
    expect(facts).toContain('- K: start Butker (K, projected 8.5) in a slot that is currently empty.');
  });

  it('lets a faithful explanation through the number guard', () => {
    const facts = lineupFacts(base);
    const text =
      "Swap Michael Wilson (8.3) in for Deebo Samuel Sr. (7.4) at WR for a 0.9-point gain. You're still behind Joan of Yard, but the gap closes from 4.1 to 3.2.";
    expect(checkNumbers(text, facts).ok).toBe(true);
  });
});

describe('tradeFacts', () => {
  const facts = tradeFacts({
    week: 1,
    myTeam: "Tony's Personal Computer",
    opponentTeam: 'Ceebee',
    give: 'Trevor Lawrence',
    giveProjected: 18.4,
    get: 'Tee Higgins',
    getProjected: 10.8,
    theirGain: 0.3,
  });

  it('states the trade from the side of the manager being addressed', () => {
    // Phrased from the sender's side, a local model once reversed the trade.
    expect(facts).toContain('Ceebee would receive Trevor Lawrence (projected 18.4).');
    expect(facts).toContain("Ceebee would send Tee Higgins (projected 10.8) to Tony's Personal Computer.");
    expect(facts).toContain('improves by 0.3 points');
  });

  it('says it is a first offer, so the message cannot claim a done deal', () => {
    expect(facts).toContain('Ceebee has not agreed to anything');
  });

  it('keeps the sender’s own gain out, so a pitch cannot leak it', () => {
    // The finder computed +2.5 for the sender. The model is never told, and any
    // pitch that states it is withheld by the guard.
    expect(facts).not.toContain('2.5');
    expect(checkNumbers('This nets me 2.5 points, and you 0.3.', facts).invented).toEqual([2.5]);
  });
});
