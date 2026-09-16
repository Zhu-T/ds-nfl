import { describe, it, expect } from 'vitest';
import { clampWeek, planningWeek } from './weeks.js';

describe('planningWeek', () => {
  it('shows the week being played, or the next one', () => {
    expect(planningWeek('this', 1, 17)).toBe(1);
    expect(planningWeek('next', 1, 17)).toBe(2);
  });

  it('has no next week after the final one', () => {
    expect(planningWeek('next', 17, 17)).toBe(17);
  });
});

describe('clampWeek', () => {
  it('keeps a requested week inside the season', () => {
    expect(clampWeek(2, 1, 17)).toBe(2);
    expect(clampWeek(40, 1, 17)).toBe(17);
  });

  it('never goes back to a week that has finished', () => {
    expect(clampWeek(1, 3, 17)).toBe(3);
  });

  it('falls back to the week being played for nonsense', () => {
    expect(clampWeek(Number.NaN, 4, 17)).toBe(4);
    expect(clampWeek(2.7, 1, 17)).toBe(2);
  });
});
