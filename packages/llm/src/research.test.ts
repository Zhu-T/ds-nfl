import { describe, it, expect } from 'vitest';
import { newsResearchRequest, normalizeUrl, parseNewsFindings, type ResearchPlayer } from './research.js';
import { LlmError } from './types.js';

const players: ResearchPlayer[] = [
  { id: '1', name: 'Kyle Pitts Sr.', position: 'TE', proTeam: 'ATL', projected: 7.6, role: 'starter' },
  { id: '2', name: 'Deebo Samuel Sr.', position: 'WR', proTeam: 'WSH', projected: 7.4, role: 'bench' },
  { id: '3', name: 'Tre Tucker', position: 'WR', proTeam: 'LV', projected: 8.4, role: 'pickup' },
];

const pages = [
  { url: 'https://www.espn.com/nfl/story/_/id/1/pitts-injury', title: 'Pitts injury update' },
  { url: 'https://www.nfl.com/news/deebo-role/', title: 'Deebo role' },
];

const report = (findings: unknown[]) => `Here is what I found.\n\n\`\`\`json\n${JSON.stringify({ findings })}\n\`\`\``;

describe('newsResearchRequest', () => {
  const req = newsResearchRequest({ leagueName: "Tommy's League", week: 2, today: '2026-09-14', players });

  it('lists every player with role and projection, and the week', () => {
    expect(req.user).toContain('- Kyle Pitts Sr. (TE, ATL): in the recommended lineup, ESPN projects 7.6');
    expect(req.user).toContain('- Tre Tucker (WR, LV): a possible waiver pickup, ESPN projects 8.4');
    expect(req.system).toContain('planning for week 2');
    expect(req.system).toContain('Today is 2026-09-14');
  });

  it('states the allowed range for every status', () => {
    expect(req.system).toContain('out 0 to 0; doubtful 0 to 0.5; questionable 0.5 to 1; active 0.75 to 1.25');
  });

  it('keeps the number of searches bounded', () => {
    expect(req.maxSearches).toBe(4);
    const many = Array.from({ length: 60 }, (_, i) => ({ ...players[0]!, id: String(i), name: `P${i}` }));
    expect(newsResearchRequest({ leagueName: 'L', week: 2, today: 'x', players: many }).maxSearches).toBe(12);
  });
});

describe('parseNewsFindings', () => {
  it('accepts a finding about a listed player that cites a retrieved page', () => {
    const { findings, rejected } = parseNewsFindings(
      report([
        {
          player: 'Kyle Pitts Sr.',
          status: 'questionable',
          factor: 0.8,
          summary: 'Limited in practice Thursday (Sep 17).',
          sources: ['http://www.espn.com/nfl/story/_/id/1/pitts-injury/#top'],
        },
      ]),
      players,
      pages,
    );
    expect(rejected).toEqual([]);
    expect(findings).toEqual([
      {
        playerId: '1',
        playerName: 'Kyle Pitts Sr.',
        status: 'questionable',
        factor: 0.8,
        summary: 'Limited in practice Thursday (Sep 17).',
        sources: [pages[0]],
      },
    ]);
  });

  it('rejects a finding whose only sources were never returned by the search', () => {
    const { findings, rejected } = parseNewsFindings(
      report([{ player: 'Kyle Pitts Sr.', status: 'out', summary: 'Out.', sources: ['https://made-up.example/pitts'] }]),
      players,
      pages,
    );
    expect(findings).toEqual([]);
    expect(rejected).toEqual([{ player: 'Kyle Pitts Sr.', reason: 'cited sources that were never retrieved' }]);
  });

  it('rejects players the app did not ask about, unknown statuses, and findings without sources', () => {
    const { findings, rejected } = parseNewsFindings(
      report([
        { player: 'Justin Jefferson', status: 'out', summary: 'Out.', sources: [pages[0]!.url] },
        { player: 'Tre Tucker', status: 'probable', summary: 'Fine.', sources: [pages[0]!.url] },
        { player: 'Deebo Samuel Sr.', status: 'active', summary: 'Bigger role.', sources: [] },
      ]),
      players,
      pages,
    );
    expect(findings).toEqual([]);
    expect(rejected.map((r) => r.reason)).toEqual([
      'not one of the players the app asked about',
      'unknown status "probable"',
      'no sources',
    ]);
  });

  it('clamps factors to the range for the status', () => {
    const { findings } = parseNewsFindings(
      report([
        { player: 'Kyle Pitts Sr.', status: 'out', factor: 0.9, summary: 'Ruled out.', sources: [pages[0]!.url] },
        { player: 'Deebo Samuel Sr.', status: 'active', factor: 3, summary: 'Lead role.', sources: [pages[1]!.url] },
        { player: 'Tre Tucker', status: 'questionable', factor: 0.1, summary: 'DNP Wednesday.', sources: [pages[1]!.url] },
      ]),
      players,
      pages,
    );
    expect(findings.map((f) => [f.playerName, f.factor])).toEqual([
      ['Kyle Pitts Sr.', 0],
      ['Deebo Samuel Sr.', 1.25],
      ['Tre Tucker', 0.5],
    ]);
  });

  it('reads an empty report as no findings', () => {
    expect(parseNewsFindings(report([]), players, pages)).toEqual({ findings: [], rejected: [] });
  });

  it('refuses a report without the findings block', () => {
    expect(() => parseNewsFindings('Pitts looks fine.', players, pages)).toThrow(LlmError);
    expect(() => parseNewsFindings('```json\n{not json}\n```', players, pages)).toThrow(/not valid JSON/);
  });

  it('normalizes URLs for comparison only', () => {
    expect(normalizeUrl('http://Example.com/A/#x')).toBe('https://example.com/a');
  });
});
