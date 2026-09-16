import { describe, it, expect } from 'vitest';
import {
  resolveSeasons,
  platformProjectionWeight,
  MIN_WEEKS_FOR_CURRENT_SEASON_STATS,
} from './seasons.js';

// The live situation this module was written against.
const WEEK_1_2026 = { season: 2026, week: 1 };

describe('resolveSeasons', () => {
  it('never falls back for schedules — wrong byes are silent corruption', () => {
    const r = resolveSeasons('schedules', WEEK_1_2026);
    expect(r.seasons).toEqual([2026]);
    expect(r.currentSeasonUsable).toBe(true);
    expect(r.seasons).not.toContain(2025);
  });

  it('never falls back for rosters', () => {
    expect(resolveSeasons('rosters', WEEK_1_2026).seasons).toEqual([2026]);
  });

  it('uses only the current season for injuries', () => {
    const r = resolveSeasons('injuries', WEEK_1_2026);
    expect(r.seasons).toEqual([2026]);
  });

  it('excludes the current season from weekly stats before enough weeks are played', () => {
    const r = resolveSeasons('weeklyStats', WEEK_1_2026);
    expect(r.currentSeasonUsable).toBe(false);
    expect(r.seasons).toEqual([2025, 2024, 2023]);
    expect(r.seasons).not.toContain(2026);
    expect(r.reason).toMatch(/fewer than 4 weeks/);
  });

  it('includes the current season once enough weeks are played', () => {
    const r = resolveSeasons('weeklyStats', {
      season: 2026,
      week: MIN_WEEKS_FOR_CURRENT_SEASON_STATS,
    });
    expect(r.currentSeasonUsable).toBe(true);
    expect(r.seasons[0]).toBe(2026);
    expect(r.seasons).toContain(2025);
  });

  it('handles preseason (week 0) as no current-season stats', () => {
    const r = resolveSeasons('weeklyStats', { season: 2026, week: 0 });
    expect(r.currentSeasonUsable).toBe(false);
    expect(r.seasons).toEqual([2025, 2024, 2023]);
  });

  it('always explains its choice', () => {
    for (const ds of ['schedules', 'rosters', 'injuries', 'weeklyStats'] as const) {
      expect(resolveSeasons(ds, WEEK_1_2026).reason).not.toHaveLength(0);
    }
  });
});

describe('platformProjectionWeight', () => {
  it('leans on the platform projection when we have no usage data', () => {
    expect(platformProjectionWeight(1)).toBeCloseTo(0.8, 6);
    expect(platformProjectionWeight(0)).toBeCloseTo(0.8, 6);
  });

  it('decays as real usage accumulates', () => {
    expect(platformProjectionWeight(2)).toBeLessThan(platformProjectionWeight(1));
    expect(platformProjectionWeight(5)).toBeLessThan(platformProjectionWeight(3));
  });

  it('never drops below the floor or exceeds the start', () => {
    for (let week = 0; week <= 20; week++) {
      const w = platformProjectionWeight(week);
      expect(w).toBeGreaterThanOrEqual(0.2);
      expect(w).toBeLessThanOrEqual(0.8);
    }
    expect(platformProjectionWeight(18)).toBeCloseTo(0.2, 6);
  });

  it('is monotonically non-increasing across the season', () => {
    let prev = platformProjectionWeight(0);
    for (let week = 1; week <= 18; week++) {
      const w = platformProjectionWeight(week);
      expect(w).toBeLessThanOrEqual(prev);
      prev = w;
    }
  });
});
