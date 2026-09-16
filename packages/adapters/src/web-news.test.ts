import { describe, it, expect, beforeEach } from 'vitest';
import { gatherPlayerNews, parseGoogleNewsRss, searchName, searchPlayerHeadlines } from './web-news.js';
import { clearNewsCache } from './espn/news.js';

const NOW = Date.parse('2026-09-17T12:00:00Z');

const rss = (items: { title: string; source: string; date: string; link?: string }[]) =>
  `<?xml version="1.0"?><rss><channel>${items
    .map(
      (i) =>
        `<item><title>${i.title} - ${i.source}</title><link>${i.link ?? 'https://news.google.com/rss/articles/abc?oc=5'}</link><pubDate>${i.date}</pubDate><description>&lt;a href="x"&gt;y&lt;/a&gt;</description><source url="https://example.com">${i.source}</source></item>`,
    )
    .join('')}</channel></rss>`;

beforeEach(() => clearNewsCache());

describe('parseGoogleNewsRss', () => {
  it('reads title, link, outlet, and date, dropping the outlet suffix and decoding entities', () => {
    const [h] = parseGoogleNewsRss(
      rss([{ title: 'Pitts &amp; Falcons: &#39;limited&#39; &quot;Wednesday&quot;', source: 'NBC Sports', date: 'Wed, 16 Sep 2026 21:09:00 GMT' }]),
    );
    expect(h).toEqual({
      title: 'Pitts & Falcons: \'limited\' "Wednesday"',
      url: 'https://news.google.com/rss/articles/abc?oc=5',
      source: 'NBC Sports',
      published: '2026-09-16T21:09:00.000Z',
    });
  });

  it('skips items without a link or a date', () => {
    expect(parseGoogleNewsRss(rss([{ title: 'T', source: 'S', date: 'not a date' }]))).toEqual([]);
    expect(parseGoogleNewsRss(rss([{ title: 'T', source: 'S', date: 'Wed, 16 Sep 2026 21:09:00 GMT', link: 'javascript:alert(1)' }]))).toEqual([]);
  });
});

describe('searchPlayerHeadlines', () => {
  it('searches the name as the news writes it, and keeps recent headlines that name the player', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(
        rss([
          { title: 'Kyle Pitts limited in practice', source: 'ESPN', date: 'Wed, 16 Sep 2026 20:00:00 GMT' },
          { title: 'Falcons inactives for Week 1', source: 'Falcons', date: 'Sun, 13 Sep 2026 16:00:00 GMT' },
          { title: 'Pitts had a big 2024', source: 'Old', date: 'Mon, 01 Sep 2025 16:00:00 GMT' },
          { title: 'Pitts sees one target', source: 'NBC Sports', date: 'Sun, 13 Sep 2026 21:00:00 GMT' },
        ]),
      );
    }) as typeof fetch;

    const found = await searchPlayerHeadlines('Kyle Pitts Sr.', { fetchImpl, now: NOW });
    expect(new URL(urls[0]!).searchParams.get('q')).toBe('"Kyle Pitts" NFL when:7d');
    expect(found.map((h) => h.title)).toEqual(['Kyle Pitts limited in practice', 'Pitts sees one target']);
  });

  it('strips name suffixes', () => {
    expect(searchName('Deebo Samuel Sr.')).toBe('Deebo Samuel');
    expect(searchName('Marvin Harrison Jr.')).toBe('Marvin Harrison');
    expect(searchName('Michael Pittman III')).toBe('Michael Pittman');
    expect(searchName('Tre Tucker')).toBe('Tre Tucker');
  });
});

describe('gatherPlayerNews', () => {
  /** ESPN's feed for player 1, headlines for everyone, and a failing search for player 3. */
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname === 'site.api.espn.com') {
      const feed =
        url.searchParams.get('playerId') === '1'
          ? [{ type: 'Rotowire', id: 9, playerId: 1, headline: 'Pitts limited Wednesday.', story: 'Ankle issue.', published: '2026-09-16T18:00:00Z' }]
          : [];
      return new Response(JSON.stringify({ feed }));
    }
    const q = url.searchParams.get('q') ?? '';
    if (q.includes('Tucker')) return new Response('nope', { status: 503 });
    const surname = q.includes('Pitts') ? 'Pitts' : 'Samuel';
    return new Response(rss([{ title: `${surname} news`, source: 'Outlet', date: 'Tue, 15 Sep 2026 12:00:00 GMT' }]));
  }) as typeof fetch;

  it('groups ESPN blurbs and headlines by player, newest first, and counts what failed', async () => {
    const result = await gatherPlayerNews(
      [
        { id: '1', name: 'Kyle Pitts Sr.', position: 'TE' },
        { id: '2', name: 'Deebo Samuel Sr.', position: 'WR' },
        { id: '3', name: 'Tre Tucker', position: 'WR' },
        { id: '4', name: 'Eagles D/ST', position: 'DST' },
      ],
      { fetchImpl, now: NOW },
    );

    expect(result.items).toEqual([
      {
        playerId: '1',
        url: 'https://www.espn.com/nfl/player/_/id/1',
        source: 'ESPN',
        published: '2026-09-16',
        title: 'Pitts limited Wednesday.',
        text: 'Ankle issue.',
      },
      { playerId: '1', url: 'https://news.google.com/rss/articles/abc?oc=5', source: 'Outlet', published: '2026-09-15', title: 'Pitts news' },
      { playerId: '2', url: 'https://news.google.com/rss/articles/abc?oc=5', source: 'Outlet', published: '2026-09-15', title: 'Samuel news' },
    ]);
    // Four ESPN lookups, three headline searches (no search for a team defense).
    expect(result.requests).toBe(7);
    expect(result.failed).toBe(1);
  });
});
