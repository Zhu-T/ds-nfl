import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeFindings,
  clearNewsReport,
  readNewsReport,
  setFindingEnabled,
  writeNewsReport,
  type NewsReport,
} from './news-reports.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ds-nfl-webnews-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const report = (week: number): NewsReport => ({
  leagueKey: 'espn:1:2026',
  week,
  checkedAt: '2026-09-17T15:00:00Z',
  model: 'claude-opus-5',
  searches: 5,
  findings: [
    { playerId: 'a', playerName: 'A', status: 'out', factor: 0, summary: 'Ruled out.', sources: [{ url: 'https://x/a', title: 'A' }] },
    { playerId: 'b', playerName: 'B', status: 'questionable', factor: 0.8, summary: 'Limited.', sources: [{ url: 'https://x/b', title: 'B' }] },
  ],
  rejected: [],
  disabled: [],
});

describe('web news reports', () => {
  it('saves and reads a report per league and week', () => {
    expect(readNewsReport('espn:1:2026', 2, dir)).toBeNull();
    writeNewsReport(report(2), dir);
    expect(readNewsReport('espn:1:2026', 2, dir)?.findings).toHaveLength(2);
    expect(readNewsReport('espn:1:2026', 3, dir)).toBeNull();
  });

  it('switches findings off and on, and applies only the ones in effect', () => {
    writeNewsReport(report(2), dir);
    setFindingEnabled('espn:1:2026', 2, 'a', false, dir);
    expect(activeFindings(readNewsReport('espn:1:2026', 2, dir)).map((f) => f.playerId)).toEqual(['b']);
    setFindingEnabled('espn:1:2026', 2, 'a', true, dir);
    expect(activeFindings(readNewsReport('espn:1:2026', 2, dir)).map((f) => f.playerId)).toEqual(['a', 'b']);
  });

  it('clears a report', () => {
    writeNewsReport(report(2), dir);
    clearNewsReport('espn:1:2026', 2, dir);
    expect(readNewsReport('espn:1:2026', 2, dir)).toBeNull();
    expect(activeFindings(null)).toEqual([]);
  });

  it('reads a corrupt report as none', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'espn_1_2026_w2.json'), '{oops', 'utf8');
    expect(readNewsReport('espn:1:2026', 2, dir)).toBeNull();
  });
});
