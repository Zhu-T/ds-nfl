import { describe, it, expect } from 'vitest';
import {
  charBudget,
  estimateTokens,
  promptTokens,
  windowFor,
  windowForParts,
  windowForTokens,
} from './window.js';

describe('estimateTokens', () => {
  it('counts a token for every two and a half characters, rounding up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('a'.repeat(1_000))).toBe(400);
  });

  it('adds up the parts of a prompt', () => {
    expect(promptTokens(['abcde', 'abcde'])).toBe(4);
  });
});

describe('windowFor', () => {
  it('rounds up to a whole block, with room left to answer', () => {
    // 10,000 characters is 4,000 tokens, plus 1,024 to answer, rounded to 8,192.
    expect(windowFor(10_000)).toBe(8_192);
    // 30,000 characters is 12,000 tokens; 12,000 + 1,024 rounds to 16,384.
    expect(windowFor(30_000)).toBe(16_384);
  });

  it('never asks for less than the floor or more than the cap', () => {
    expect(windowFor(10)).toBe(8_192);
    expect(windowFor(10_000_000)).toBe(32_768);
    expect(windowFor(10_000_000, { max: 65_536 })).toBe(65_536);
    // A cap below the floor is raised to it: a smaller window could hold nothing.
    expect(windowFor(10_000_000, { max: 2_048 })).toBe(8_192);
  });

  it('covers the request that failed, which the old three-characters-a-token guess did not', () => {
    // The refused prompt was 16,619 tokens while the app had asked for 16,384.
    const chars = 16_619 * 2.5;
    expect(windowFor(chars)).toBeGreaterThan(16_619);
    expect(windowFor(chars)).toBe(20_480);
  });

  it('takes the prompt in parts', () => {
    expect(windowForParts(['a'.repeat(15_000), 'a'.repeat(15_000)])).toBe(windowFor(30_000));
  });
});

describe('windowForTokens', () => {
  it('sizes from a token count the server has already reported', () => {
    expect(windowForTokens(16_619)).toBe(20_480);
    expect(windowForTokens(40_000)).toBe(32_768);
    expect(windowForTokens(40_000, { max: 65_536 })).toBe(45_056);
  });
});

describe('charBudget', () => {
  it('is the characters that fit, once the answer has its room', () => {
    expect(charBudget(8_192)).toBe((8_192 - 1_024) * 2.5);
    expect(charBudget(1_000, { reserve: 2_000 })).toBe(0);
  });
});
