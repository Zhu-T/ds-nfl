import { describe, it, expect } from 'vitest';
import { newsResearchRequest, parseNewsFindings, sourceTime, weekBefore, type ResearchPlayer } from './research.js';
import { parseWaiverPicks, waiverPicksResearchRequest } from './waiver-picks.js';
import { collectSources } from './claude.js';


const NOW = Date.parse('2026-09-17T12:00:00Z');
const WEEK_AGO = NOW - 7 * 86_400_000;

const players: ResearchPlayer[] = [
  { id: '1', name: 'Kyle Pitts Sr.', position: 'TE', proTeam: 'ATL', projected: 7.6, role: 'starter' },
];

const report = (key: string, items: unknown[]) => `\`\`\`json\n${JSON.stringify({ [key]: items })}\n\`\`\``;

describe('the one-week window', () => {
  it('puts the cutoff date in the prompts', () => {
    expect(weekBefore('2026-09-17')).toBe('2026-09-10');
    expect(newsResearchRequest({ leagueName: 'L', week: 2, today: '2026-09-17', players }).system).toContain(
      'Use only reports published in the last 7 days, on or after 2026-09-10',
    );
    expect(waiverPicksResearchRequest({ week: 2, today: '2026-09-17' }).system).toContain('on or after 2026-09-10');
  });

  it('reads search result ages and dates', () => {
    expect(sourceTime('3 days ago', NOW)).toBe(NOW - 3 * 86_400_000);
    expect(sourceTime('September 16, 2026', NOW)).toBe(Date.parse('September 16, 2026'));
    expect(sourceTime(undefined, NOW)).toBeNull();
    expect(sourceTime('undated', NOW)).toBeNull();
  });

  it('refuses a news finding whose only sources are older than a week', () => {
    const pages = [
      { url: 'https://a.example/old', title: 'Old', published: '3 weeks ago' },
      { url: 'https://a.example/new', title: 'New', published: '2 days ago' },
    ];
    const old = parseNewsFindings(
      report('findings', [{ player: 'Kyle Pitts Sr.', status: 'out', summary: 'Out.', sources: ['https://a.example/old'] }]),
      players,
      pages,
      { notBefore: WEEK_AGO, now: NOW },
    );
    expect(old.findings).toEqual([]);
    expect(old.rejected).toEqual([{ player: 'Kyle Pitts Sr.', reason: 'its sources are more than a week old' }]);

    const fresh = parseNewsFindings(
      report('findings', [{ player: 'Kyle Pitts Sr.', status: 'out', summary: 'Out.', sources: ['https://a.example/old', 'https://a.example/new'] }]),
      players,
      pages,
      { notBefore: WEEK_AGO, now: NOW },
    );
    expect(fresh.findings[0]!.sources.map((s) => s.url)).toEqual(['https://a.example/new']);
  });

  it('refuses a waiver pick whose only sources are older than a week', () => {
    const { picks, rejected } = parseWaiverPicks(
      report('picks', [{ player: 'Kaelon Black', reason: 'Starter.', sources: ['https://b.example/old'] }]),
      [{ url: 'https://b.example/old', title: 'Old', published: 'August 30, 2026' }],
      { notBefore: WEEK_AGO, now: NOW },
    );
    expect(picks).toEqual([]);
    expect(rejected[0]!.reason).toBe('its sources are more than a week old');
  });
});

describe('page ages from Claude search results', () => {
  const result = { type: 'web_search_result', url: 'https://a.example/p', title: 'P', page_age: 'September 1, 2026' };
  const citation = { type: 'web_search_result_location', url: 'https://a.example/p', title: 'P', cited_text: 'x' };

  it('keeps the age whichever block names the page first', () => {
    for (const order of [[result, citation], [citation, result]]) {
      const into = new Map();
      collectSources([{ type: 'web_search_tool_result', content: [order[0]] }, { type: 'text', citations: [order[1]] }], into);
      expect([...into.values()]).toEqual([{ url: 'https://a.example/p', title: 'P', published: 'September 1, 2026' }]);
    }
  });
});
