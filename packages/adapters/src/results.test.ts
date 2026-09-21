import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listWeekResults,
  mergeSnapshot,
  readSnapshot,
  readWeekResults,
  writeSnapshot,
  writeWeekResults,
  type PlayerSnapshot,
  type WeekResults,
} from './results.js';

const row = (id: string, projected: number, extra: Partial<PlayerSnapshot> = {}): PlayerSnapshot => ({
  id,
  name: `Player ${id}`,
  position: 'WR',
  proTeam: 'DET',
  ownerKind: 'mine',
  espn: 10,
  projected,
  capturedAt: '2026-09-20T12:00:00Z',
  beforeKickoff: true,
  ...extra,
});

describe('mergeSnapshot', () => {
  it('adds players and updates their entries field by field', () => {
    const first = mergeSnapshot(null, 'espn:1:2026', 2, [row('1', 11, { slot: 'WR' })]);
    const second = mergeSnapshot(first, 'espn:1:2026', 2, [row('1', 12, { gain: 0 }), row('2', 5, { ownerKind: 'waivers' })]);
    expect(second.players['1']).toMatchObject({ projected: 12, slot: 'WR', gain: 0 });
    expect(second.players['2']!.ownerKind).toBe('waivers');
  });

  it('never replaces what was believed before kickoff with numbers taken after the game locked', () => {
    const before = mergeSnapshot(null, 'espn:1:2026', 2, [row('1', 11)]);
    const after = mergeSnapshot(before, 'espn:1:2026', 2, [row('1', 0, { beforeKickoff: false })]);
    expect(after.players['1']).toMatchObject({ projected: 11, beforeKickoff: true });
    // But a player first seen after kickoff is still kept, marked as such.
    expect(mergeSnapshot(null, 'k', 2, [row('3', 7, { beforeKickoff: false })]).players['3']!.beforeKickoff).toBe(false);
  });
});

describe('the results store', () => {
  it('saves snapshots and results per league and week, and lists results in order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'results-'));
    try {
      writeSnapshot(mergeSnapshot(null, 'espn:1:2026', 2, [row('1', 11)]), dir);
      expect(readSnapshot('espn:1:2026', 2, dir)!.players['1']!.projected).toBe(11);
      expect(readSnapshot('espn:1:2026', 3, dir)).toBeNull();

      const week = (w: number): WeekResults => ({
        leagueKey: 'espn:1:2026',
        week: w,
        recordedAt: 'now',
        snapshotted: false,
        lineup: { set: 100, recommended: 104, recommendedFrom: 'espn', best: 120 },
        players: [],
      });
      writeWeekResults(week(2), dir);
      writeWeekResults(week(1), dir);
      expect(readWeekResults('espn:1:2026', 1, dir)!.lineup!.best).toBe(120);
      expect(listWeekResults(dir).map((r) => r.week)).toEqual([1, 2]);
      expect(listWeekResults(join(dir, 'missing'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
