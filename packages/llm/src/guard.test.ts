import { describe, it, expect } from 'vitest';
import { checkNumbers, extractNumbers } from './guard.js';

describe('extractNumbers', () => {
  it('finds integers and decimals, unsigned', () => {
    expect(extractNumbers('margin -4.1, gain +0.9, 104 points')).toEqual([4.1, 0.9, 104]);
  });
});

describe('checkNumbers', () => {
  const facts = 'Wilson projected 8.3. Samuel projected 7.4. Margin with the current lineup: -4.1.';

  it('accepts text that only uses numbers from the facts', () => {
    expect(checkNumbers('Start Wilson at 8.3 over Samuel at 7.4.', facts).ok).toBe(true);
  });

  it('accepts a margin written without its sign', () => {
    // The facts say -4.1; "behind by 4.1" is the same claim.
    expect(checkNumbers("You're behind by 4.1.", facts).ok).toBe(true);
  });

  it('rejects a projection the engine never produced', () => {
    const result = checkNumbers('Wilson should score 11.2 this week.', facts);
    expect(result.ok).toBe(false);
    expect(result.invented).toEqual([11.2]);
  });

  it('allows small counts, which are prose rather than claims', () => {
    expect(checkNumbers('Make 2 changes and bench 1 player.', facts).ok).toBe(true);
  });

  it('rejects larger counts that are not in the facts', () => {
    expect(checkNumbers('You have 7 players locked.', facts).invented).toEqual([7]);
  });

  it('tolerates re-rounding to the same tenth, but not a different value', () => {
    expect(checkNumbers('about 104.4', 'projects 104.36').ok).toBe(true);
    expect(checkNumbers('about 104.5', 'projects 104.4').ok).toBe(false);
  });

  it('allows digits that are part of a name in the facts', () => {
    expect(checkNumbers('eyeshield 67 comes out ahead.', 'Opponent: eyeshield 67.').ok).toBe(true);
  });

  it('reports each invented number once', () => {
    expect(checkNumbers('11.2, then 11.2 again, and 13.7', facts).invented).toEqual([11.2, 13.7]);
  });
});
