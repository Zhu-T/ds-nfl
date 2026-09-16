import { describe, it, expect } from 'vitest';
import { composePitch, tradeFacts, tradeTerms, type TradeFactsInput } from './facts.js';
import { namesIn, pitchReasonOk } from './guard.js';

const trade: TradeFactsInput = {
  week: 1,
  myTeam: "Tony's Personal Computer",
  opponentTeam: 'Ceebee',
  give: 'Trevor Lawrence',
  giveProjected: 18.4,
  get: 'Tee Higgins',
  getProjected: 10.8,
  theirGain: 0.3,
};

describe('tradeTerms', () => {
  it('states who gets which player, from the side of the manager being addressed', () => {
    expect(tradeTerms(trade)).toBe(
      "Trade offer: you'd get Trevor Lawrence (projected 18.4) for Tee Higgins (projected 10.8).",
    );
  });
});

describe('composePitch', () => {
  it("puts the app's terms first and the model's reason after", () => {
    expect(composePitch('TERMS.', 'Reason.')).toBe('TERMS. Reason.');
  });

  it('falls back to the terms alone', () => {
    expect(composePitch('TERMS.', null)).toBe('TERMS.');
  });
});

describe('namesIn', () => {
  const names = ['Trevor Lawrence', 'Tee Higgins'];

  it('catches a model sentence that restates the trade backwards', () => {
    // A real draft from deepseek-r1:14b during live testing.
    const reversed =
      "I'd send you Tee Higgins (projected 10.8) in exchange for Trevor Lawrence (projected 18.4).";
    expect(namesIn(reversed, names)).toEqual(['Trevor Lawrence', 'Tee Higgins']);
  });

  it('catches a surname on its own', () => {
    expect(namesIn('Adding Lawrence gives you a real upgrade.', names)).toEqual(['Trevor Lawrence']);
  });

  it('ignores generational suffixes when matching a surname', () => {
    expect(namesIn('Samuel would help you.', ['Deebo Samuel Sr.'])).toEqual(['Deebo Samuel Sr.']);
  });

  it('passes a reason that names nobody', () => {
    expect(namesIn('Your best starting lineup improves by 0.3 points right away.', names)).toEqual([]);
  });

  it('does not match a surname inside a longer word', () => {
    expect(namesIn('The Higginsons league is tough.', names)).toEqual([]);
  });
});

describe('pitchReasonOk', () => {
  const facts = tradeFacts(trade);
  // Ceebee would give up Tee Higgins.
  const givesUp = trade.get;

  it('accepts a reason naming the player the recipient receives, in the right role', () => {
    // Real drafts: five of six named Lawrence this way, and all were correct.
    const draft =
      'Adding Trevor Lawrence to your lineup would improve your starting lineup by 0.3 points, making this a strong offer worth considering.';
    expect(pitchReasonOk(draft, facts, givesUp)).toBe(true);
  });

  it('rejects a reason that names the player the recipient would give up', () => {
    // Every reversed draft seen named Higgins as the player Ceebee would get.
    const reversed =
      "I'd send you Tee Higgins (projected 10.8) in exchange for Trevor Lawrence (projected 18.4).";
    expect(pitchReasonOk(reversed, facts, givesUp)).toBe(false);
    expect(pitchReasonOk('Higgins is a great fit for you.', facts, givesUp)).toBe(false);
  });

  it('rejects a reason with a number the engine did not produce', () => {
    expect(pitchReasonOk('Your lineup gains 2.5 points.', facts, givesUp)).toBe(false);
  });

  it('rejects an empty reason', () => {
    expect(pitchReasonOk('   ', facts, givesUp)).toBe(false);
  });
});
