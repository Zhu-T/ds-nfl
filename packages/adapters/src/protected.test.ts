import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { protectedIds, readProtected, setProtected, writeProtected } from './protected.js';

describe('protected players', () => {
  it('saves, reads back, and toggles one player at a time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'protected-'));
    try {
      expect(readProtected('espn:1:2026', dir)).toBeNull();
      expect(protectedIds('espn:1:2026', dir).size).toBe(0);

      writeProtected('espn:1:2026', ['9', '4', '9'], dir);
      expect(readProtected('espn:1:2026', dir)!.ids).toEqual(['4', '9']);

      setProtected('espn:1:2026', '7', true, dir);
      expect([...protectedIds('espn:1:2026', dir)]).toEqual(['4', '7', '9']);
      setProtected('espn:1:2026', '4', false, dir);
      expect([...protectedIds('espn:1:2026', dir)]).toEqual(['7', '9']);

      // Leagues are kept apart.
      expect(protectedIds('espn:2:2026', dir).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats a corrupt file as nothing protected, rather than blocking every drop', () => {
    const dir = mkdtempSync(join(tmpdir(), 'protected-'));
    try {
      writeFileSync(join(dir, 'espn_1_2026.protected.json'), '{ not json', 'utf8');
      expect(protectedIds('espn:1:2026', dir).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
