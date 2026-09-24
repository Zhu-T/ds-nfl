import { describe, it, expect } from 'vitest';
import { acceptanceLabel, tradeAcceptance } from './acceptance.js';

describe('tradeAcceptance', () => {
  it('rises with what their lineup gains', () => {
    const small = tradeAcceptance({ theirGain: 0.3, theyReceive: 10, theySend: 10 });
    const fair = tradeAcceptance({ theirGain: 1.5, theyReceive: 10, theySend: 10 });
    const large = tradeAcceptance({ theirGain: 5, theyReceive: 10, theySend: 10 });
    expect(small).toBeLessThan(fair);
    expect(fair).toBeCloseTo(0.5, 1);
    expect(large).toBeGreaterThan(fair);
  });

  it('discounts a deal where they send the better-projected player', () => {
    const even = tradeAcceptance({ theirGain: 2, theyReceive: 12, theySend: 12 });
    const sendsBetter = tradeAcceptance({ theirGain: 2, theyReceive: 6, theySend: 18 });
    expect(sendsBetter).toBeLessThan(even);
  });

  it('never claims certainty either way', () => {
    expect(tradeAcceptance({ theirGain: -5, theyReceive: 1, theySend: 20 })).toBeGreaterThanOrEqual(0.05);
    expect(tradeAcceptance({ theirGain: 50, theyReceive: 30, theySend: 1 })).toBeLessThanOrEqual(0.9);
  });

  it('describes the number in words', () => {
    expect(acceptanceLabel(0.1)).toBe('unlikely');
    expect(acceptanceLabel(0.35)).toBe('worth asking');
    expect(acceptanceLabel(0.55)).toBe('even odds');
    expect(acceptanceLabel(0.8)).toBe('likely');
  });
});
