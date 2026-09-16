import { describe, it, expect } from 'vitest';
import { lastJsonBlock } from './research.js';
import { parseWaiverPicks } from './waiver-picks.js';

describe('lastJsonBlock', () => {
  it('takes the last fenced block when there is one', () => {
    expect(lastJsonBlock('```json\n{"findings": [1]}\n```\ntext\n```json\n{"findings": [2]}\n```')).toBe('{"findings": [2]}');
  });

  it('finds an unfenced block for the expected key, ignoring text after it', () => {
    expect(lastJsonBlock('Here you go:\n{"picks": [{"player": "A"}]}\nHope this helps.', 'picks')).toBe('{"picks": [{"player": "A"}]}');
    expect(lastJsonBlock('{ "findings": [] } done')).toBe('{ "findings": [] }');
    expect(lastJsonBlock('{"picks": []}')).toBeNull();
  });

  it('takes the last complete object when the block is written twice or cut off', () => {
    expect(lastJsonBlock('{"picks": [1]}\n{"picks": [2]}', 'picks')).toBe('{"picks": [2]}');
    expect(lastJsonBlock('{"picks": [1]}\n{"picks": [2, ', 'picks')).toBe('{"picks": [1]}');
  });

  it('is not fooled by braces or quotes inside strings', () => {
    const block = '{"picks": [{"player": "A", "reason": "a {big} \\"role\\" }"}]}';
    expect(lastJsonBlock(`${block} trailing }`, 'picks')).toBe(block);
  });
});

describe('parseWaiverPicks on an unfenced answer', () => {
  it('reads picks a local model wrote without a fence, twice, as ds-nfl-lora does', () => {
    const answer = [
      '{"picks": [',
      '{"player": "Jalen Coker", "position": "WR", "reason": "A long first draft.", "sources": [1]}',
      ']}',
      '{"picks": [',
      '{"player": "Jalen Coker", "position": "WR", "reason": "A top pickup, recommended by Yahoo.", "sources": [1]},',
      '{"player": "Panthers D/ST", "position": "DST", "reason": "A streaming defense.", "sources": [2]}',
      ']}',
    ].join('\n');
    const sources = [
      { url: 'https://sports.yahoo.com/a', title: 'Yahoo: adds' },
      { url: 'https://fantasypros.com/b', title: 'FantasyPros: streamers' },
    ];
    const { picks } = parseWaiverPicks(answer, sources, { numbered: true });
    expect(picks.map((p) => [p.name, p.reason])).toEqual([
      ['Jalen Coker', 'A top pickup, recommended by Yahoo.'],
      ['Panthers D/ST', 'A streaming defense.'],
    ]);
  });
});
