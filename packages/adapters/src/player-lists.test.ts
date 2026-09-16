import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearPlayerLists, readPlayerList, writePlayerList, type PlayerList } from './player-lists.js';

const list = (leagueKey: string, week: number): PlayerList => ({
  leagueKey,
  week,
  updatedAt: '2026-09-15T14:00:00.000Z',
  newsSignature: '',
  players: [
    { id: '1', name: 'Tyler Shough', position: 'QB', proTeam: 'NO', owner: 'Waivers', ownerKind: 'waivers', projected: 16.6, gain: 0 },
  ],
});

function withDir(test: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'player-lists-'));
  try {
    test(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('player lists', () => {
  it('saves one list per league and week, and clears every week of one league only', () =>
    withDir((dir) => {
      writePlayerList(list('espn:1:2026', 2), dir);
      writePlayerList(list('espn:1:2026', 3), dir);
      writePlayerList(list('espn:12:2026', 2), dir);
      expect(readPlayerList('espn:1:2026', 2, dir)?.players[0]?.name).toBe('Tyler Shough');
      expect(readPlayerList('espn:1:2026', 4, dir)).toBeNull();

      clearPlayerLists('espn:1:2026', dir);
      expect(readPlayerList('espn:1:2026', 2, dir)).toBeNull();
      expect(readPlayerList('espn:1:2026', 3, dir)).toBeNull();
      expect(readPlayerList('espn:12:2026', 2, dir)).not.toBeNull();
    }));

  it('reads a corrupt file as no list, and clearing a missing folder is harmless', () =>
    withDir((dir) => {
      writeFileSync(join(dir, 'espn_1_2026_w2.json'), '{ not json', 'utf8');
      expect(readPlayerList('espn:1:2026', 2, dir)).toBeNull();
      expect(() => clearPlayerLists('espn:1:2026', join(dir, 'missing'))).not.toThrow();
    }));
});
