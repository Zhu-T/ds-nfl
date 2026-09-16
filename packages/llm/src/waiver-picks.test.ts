import { describe, it, expect } from 'vitest';
import { parseWaiverPicks, waiverPicksDigestRequest, waiverPicksResearchRequest } from './waiver-picks.js';

const items = [
  { url: 'https://news.google.com/a', source: 'NFL.com', published: '2026-09-15', title: 'Week 2 waiver wire: WR Jalen Coker, RB Kaelon Black among top targets' },
  { url: 'https://example.com/b', source: 'fantasypros.com', published: 'undated', title: 'Week 2 adds', text: 'Add Panthers D/ST as a streamer.' },
];

const answer = (picks: unknown[]) => `Here you go.\n\`\`\`json\n${JSON.stringify({ picks })}\n\`\`\``;

describe('waiver pick requests', () => {
  it('numbers the gathered items and asks for item numbers', () => {
    const { request, sources } = waiverPicksDigestRequest({ week: 2, today: '2026-09-15', items });
    expect(request.user).toContain('[1] 2026-09-15, NFL.com: Week 2 waiver wire: WR Jalen Coker, RB Kaelon Black among top targets');
    expect(request.user).toContain('[2] undated, fantasypros.com: Week 2 adds\nAdd Panthers D/ST as a streamer.');
    expect(request.system).toContain('the numbers of the items that recommend the player');
    expect(sources.map((s) => s.url)).toEqual(['https://news.google.com/a', 'https://example.com/b']);
  });

  it('asks Claude for current articles and caps its searches', () => {
    const req = waiverPicksResearchRequest({ week: 3, today: '2026-09-22' });
    expect(req.system).toContain('week 3 waiver wire articles');
    expect(req.maxSearches).toBe(5);
  });
});

describe('parseWaiverPicks', () => {
  const { sources } = waiverPicksDigestRequest({ week: 2, today: 'd', items });

  it('keeps named picks with a reason and a cited item', () => {
    const { picks, rejected } = parseWaiverPicks(
      answer([
        { player: 'Kaelon Black', position: 'RB', reason: 'Took over the backfield.', sources: [1] },
        { player: 'Panthers D/ST', position: 'D/ST', reason: 'Streamer with a good matchup.', sources: ['[2]'] },
      ]),
      sources,
      { numbered: true },
    );
    expect(rejected).toEqual([]);
    expect(picks.map((p) => [p.name, p.position, p.sources[0]!.url])).toEqual([
      ['Kaelon Black', 'RB', 'https://news.google.com/a'],
      ['Panthers D/ST', 'DST', 'https://example.com/b'],
    ]);
  });

  it('rejects picks without a reason or a retrieved source, and duplicates', () => {
    const { picks, rejected } = parseWaiverPicks(
      answer([
        { player: 'Jalen Coker', reason: '', sources: [1] },
        { player: 'Someone', reason: 'Because.', sources: [9] },
        { player: 'Kaelon Black', reason: 'Starter now.', sources: [1] },
        { player: 'kaelon black', reason: 'Again.', sources: [1] },
      ]),
      sources,
      { numbered: true },
    );
    expect(picks.map((p) => p.name)).toEqual(['Kaelon Black']);
    expect(rejected.map((r) => r.reason)).toEqual(['no reason given', 'cited sources that were never retrieved']);
  });

  it('matches URLs for a model that searched, and refuses a malformed answer', () => {
    const { picks } = parseWaiverPicks(
      answer([{ player: 'Jalen Coker', position: 'WR', reason: 'Target share.', sources: ['https://example.com/b/'] }]),
      sources,
    );
    expect(picks).toHaveLength(1);
    expect(() => parseWaiverPicks('no json here', sources)).toThrow(/agreed format/);
  });
});
