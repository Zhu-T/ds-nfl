import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendToConversation,
  clearConversation,
  readConversation,
  type ChatMessage,
} from './conversations.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ds-nfl-conv-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const msg = (role: ChatMessage['role'], content: string): ChatMessage => ({
  role,
  content,
  at: '2026-09-14T12:00:00Z',
});

describe('conversations', () => {
  it('starts empty and keeps messages in order', () => {
    expect(readConversation('espn:1:2026', dir)).toEqual([]);
    appendToConversation('espn:1:2026', [msg('user', 'q1'), msg('assistant', 'a1')], dir);
    appendToConversation('espn:1:2026', [msg('user', 'q2')], dir);
    expect(readConversation('espn:1:2026', dir).map((m) => m.content)).toEqual(['q1', 'a1', 'q2']);
  });

  it('keeps each league separate', () => {
    appendToConversation('espn:1:2026', [msg('user', 'league one')], dir);
    appendToConversation('espn:2:2026', [msg('user', 'league two')], dir);
    expect(readConversation('espn:1:2026', dir).map((m) => m.content)).toEqual(['league one']);
    expect(readConversation('espn:2:2026', dir).map((m) => m.content)).toEqual(['league two']);
  });

  it('clears one league without touching another', () => {
    appendToConversation('espn:1:2026', [msg('user', 'a')], dir);
    appendToConversation('espn:2:2026', [msg('user', 'b')], dir);
    clearConversation('espn:1:2026', dir);
    expect(readConversation('espn:1:2026', dir)).toEqual([]);
    expect(readConversation('espn:2:2026', dir)).toHaveLength(1);
  });

  it('reads a corrupt file as empty instead of throwing', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'espn_1_2026.json'), '{not json', 'utf8');
    expect(readConversation('espn:1:2026', dir)).toEqual([]);
  });

  it('keeps only the most recent 200 messages', () => {
    const many = Array.from({ length: 205 }, (_, i) => msg('user', `m${i}`));
    const stored = appendToConversation('espn:1:2026', many, dir);
    expect(stored).toHaveLength(200);
    expect(stored[0]?.content).toBe('m5');
  });
});
