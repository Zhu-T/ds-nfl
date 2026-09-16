import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatherWaiverArticles, nameKey, readWebPicks, writeWebPicks, clearWebPicks, type WebPicksReport } from './waiver-picks.js';

const NOW = Date.parse('2026-09-16T12:00:00Z');
const rss = (titles: { title: string; date: string }[]) =>
  `<rss><channel>${titles
    .map((t) => `<item><title>${t.title} - Outlet</title><link>https://news.google.com/rss/articles/${encodeURIComponent(t.title)}</link><pubDate>${t.date}</pubDate><source url="https://x.com">Outlet</source></item>`)
    .join('')}</channel></rss>`;

describe('gatherWaiverArticles', () => {
  it("keeps this week's waiver headlines, and drops other weeks, college, and stale items", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(
        rss([
          { title: 'Week 2 waiver wire: WR Jalen Coker, RB Kaelon Black among top targets', date: 'Tue, 15 Sep 2026 10:00:00 GMT' },
          { title: 'Waiver wire pickups: what free agents should you add?', date: 'Tue, 15 Sep 2026 09:00:00 GMT' },
          { title: 'Week 1 waiver wire pickups', date: 'Tue, 08 Sep 2026 09:00:00 GMT' },
          { title: 'College Fantasy Football Week 2 Waiver Wire Pickups', date: 'Tue, 15 Sep 2026 08:00:00 GMT' },
          { title: 'Week 2 waiver wire, last year', date: 'Tue, 16 Sep 2025 08:00:00 GMT' },
          { title: 'Week 2 injury report', date: 'Tue, 15 Sep 2026 07:00:00 GMT' },
        ]),
      );
    }) as typeof fetch;

    const { items, requests, sourcesUsed } = await gatherWaiverArticles(2, { fetchImpl, now: NOW });
    expect(new URL(urls[0]!).searchParams.get('q')).toBe('fantasy football "waiver wire" week 2 when:7d');
    expect(items.map((i) => i.title)).toEqual([
      'Week 2 waiver wire: WR Jalen Coker, RB Kaelon Black among top targets',
      'Waiver wire pickups: what free agents should you add?',
    ]);
    expect(requests).toBe(1);
    expect(sourcesUsed).toEqual(['Google News']);
  });

  it('adds article text from Ollama web search when a key is saved, and reports a rejected key', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).includes('ollama.com')) {
        return new Response(JSON.stringify({ results: [{ title: 'Week 2 adds', url: 'https://www.fantasypros.com/w2', content: '## Adds\n[Kaelon Black](https://x) is the top add. September 15, 2026.' }] }));
      }
      return new Response(rss([]));
    }) as typeof fetch;
    const ok = await gatherWaiverArticles(2, { fetchImpl, now: NOW, ollamaApiKey: 'k' });
    expect(ok.items).toEqual([{ url: 'https://www.fantasypros.com/w2', source: 'fantasypros.com', published: '2026-09-15', title: 'Week 2 adds', text: 'Adds Kaelon Black is the top add. September 15, 2026.' }]);

    const bad = await gatherWaiverArticles(2, {
      fetchImpl: (async (input: string | URL | Request) =>
        String(input).includes('ollama.com') ? new Response('{}', { status: 401 }) : new Response(rss([]))) as typeof fetch,
      now: NOW,
      ollamaApiKey: 'bad',
    });
    expect(bad.warnings).toEqual(['Ollama rejected the web search key. Check it at ollama.com/settings/keys.']);
  });
});

describe('web picks store', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ds-nfl-picks-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const report: WebPicksReport = {
    leagueKey: 'espn:1:2026',
    week: 2,
    checkedAt: '2026-09-15T12:00:00Z',
    model: 'deepseek-r1:14b',
    method: 'gathered',
    itemsRead: 12,
    sourcesUsed: ['Google News'],
    picks: [{ name: 'Kaelon Black', position: 'RB', reason: 'Starter now.', sources: [], playerId: '1', status: 'waivers' }],
    rejected: [],
  };

  it('saves and reads per league and week, and clears', () => {
    writeWebPicks(report, dir);
    expect(readWebPicks('espn:1:2026', 2, dir)?.picks[0]?.name).toBe('Kaelon Black');
    expect(readWebPicks('espn:1:2026', 3, dir)).toBeNull();
    clearWebPicks('espn:1:2026', 2, dir);
    expect(readWebPicks('espn:1:2026', 2, dir)).toBeNull();
  });
});

describe('nameKey', () => {
  it('compares names the way the press writes them', () => {
    expect(nameKey('Kyle Pitts Sr.')).toBe(nameKey('Kyle Pitts'));
    expect(nameKey('Marvin Harrison Jr.')).toBe(nameKey('marvin harrison'));
    expect(nameKey('Panthers D/ST')).toBe(nameKey('Panthers DST'));
    expect(nameKey("Ja'Marr Chase")).toBe('ja marr chase');
  });
});

import { matchPicks } from './waiver-picks.js';

describe('matchPicks', () => {
  const pick = (name: string) => ({ name, position: null, reason: 'Recommended.', sources: [] });

  it('labels each pick with where the player is in this league', () => {
    const matched = matchPicks(
      [pick('Kaelon Black'), pick('Jalen Coker'), pick('Panthers D/ST'), pick('Nobody Here')],
      [
        { id: '1', name: 'Kaelon Black', status: 'waivers' },
        { id: '2', name: 'Jalen Coker', status: 'rostered', rosteredBy: "Jason's Finest Team" },
        { id: '3', name: 'Panthers D/ST', status: 'free-agent' },
      ],
    );
    expect(matched.map((m) => [m.name, m.status, m.playerId, m.rosteredBy ?? null])).toEqual([
      ['Kaelon Black', 'waivers', '1', null],
      ['Jalen Coker', 'rostered', '2', "Jason's Finest Team"],
      ['Panthers D/ST', 'free-agent', '3', null],
      ['Nobody Here', 'not-found', null, null],
    ]);
  });

  it('matches names the way the press writes them, preferring an available player', () => {
    const matched = matchPicks(
      [pick('Marvin Harrison'), pick('Mike Williams')],
      [
        { id: '9', name: 'Marvin Harrison Jr.', status: 'free-agent' },
        { id: '5', name: 'Mike Williams', status: 'rostered', rosteredBy: 'you' },
        { id: '6', name: 'Mike Williams', status: 'free-agent' },
      ],
    );
    expect(matched.map((m) => [m.playerId, m.status])).toEqual([
      ['9', 'free-agent'],
      ['6', 'free-agent'],
    ]);
  });
});

import { scanMentions } from './waiver-picks.js';

describe('scanMentions', () => {
  const items = [
    { url: 'https://a', source: 'ESPN', published: '2026-09-15', title: 'Free agent pickups: Shough, Black, Coker highlight top options' },
    { url: 'https://b', source: 'Yahoo', published: '2026-09-15', title: 'Waiver wire: Tyler Shough and Denzel Boston among top targets' },
    { url: 'https://c', source: 'PFF', published: '2026-09-14', title: 'Week 2 adds', text: 'Stash Marvin Harrison and the Panthers defense.' },
  ];
  const players = [
    { id: '1', name: 'Tyler Shough', position: 'QB' },
    { id: '2', name: 'Denzel Boston', position: 'WR' },
    { id: '3', name: 'Marvin Harrison Jr.', position: 'WR' },
    { id: '4', name: 'Panthers D/ST', position: 'DST' },
    { id: '5', name: 'Sam Black', position: 'RB' },
  ];

  it('finds full names, suffixes aside, in headlines and article text', () => {
    const found = scanMentions(items, players);
    expect([...found].map(([id, hits]) => [id, hits.map((h) => h.url)])).toEqual([
      ['1', ['https://b']],
      ['2', ['https://b']],
      ['3', ['https://c']],
    ]);
  });

  it('does not match a surname alone or a team defense', () => {
    const found = scanMentions(items, players);
    expect(found.has('5')).toBe(false);
    expect(found.has('4')).toBe(false);
  });
});
