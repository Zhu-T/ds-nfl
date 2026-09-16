import { describe, it, expect, beforeEach } from 'vitest';
import { articleDate, gatherPlayerNews } from './web-news.js';
import { gatherWaiverArticles } from './waiver-picks.js';
import { clearNewsCache } from './espn/news.js';

const NOW = Date.parse('2026-09-17T12:00:00Z');
beforeEach(() => clearNewsCache());

describe('articleDate', () => {
  it('reads the most recent date a page states, in the common formats', () => {
    expect(articleDate('Updated Sep 16, 2026 · first published September 10, 2026', NOW)).toBe('2026-09-16');
    expect(articleDate('Posted 2026-09-15', NOW)).toBe('2026-09-15');
    expect(articleDate('9/14/2026 practice report', NOW)).toBe('2026-09-14');
  });

  it('ignores dates in the future, and returns null when a page states none', () => {
    expect(articleDate('Game on Dec 25, 2026. Report from Sep 15, 2026.', NOW)).toBe('2026-09-15');
    expect(articleDate('No date anywhere here.', NOW)).toBeNull();
  });
});

/** ESPN and Google News return nothing; web search returns the given pages. */
function webOnly(pages: { title: string; url: string; content: string }[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname === 'site.api.espn.com') return new Response(JSON.stringify({ feed: [] }));
    if (url.hostname === 'news.google.com') return new Response('<rss><channel></channel></rss>');
    return new Response(JSON.stringify({ results: pages }));
  }) as typeof fetch;
}

describe('news gathered only from the last week', () => {
  const pages = [
    { title: 'Pitts limited', url: 'https://a.example/new', content: 'Kyle Pitts was limited on Sep 16, 2026.' },
    { title: 'Pitts last year', url: 'https://a.example/old', content: 'Kyle Pitts missed time on Oct 2, 2025.' },
    { title: 'Pitts profile', url: 'https://a.example/undated', content: 'Kyle Pitts is a tight end.' },
  ];

  it('keeps web pages dated inside the window, and drops old and undated ones', async () => {
    const result = await gatherPlayerNews([{ id: '1', name: 'Kyle Pitts Sr.', position: 'TE' }], {
      fetchImpl: webOnly(pages),
      now: NOW,
      ollamaApiKey: 'k',
    });
    expect(result.items.map((i) => [i.url, i.published])).toEqual([['https://a.example/new', '2026-09-16']]);
  });

  it('applies the same window to waiver articles', async () => {
    const { items } = await gatherWaiverArticles(2, {
      fetchImpl: webOnly([
        { title: 'Week 2 adds', url: 'https://b.example/new', content: 'Top adds, September 15, 2026.' },
        { title: 'Week 2 adds 2025', url: 'https://b.example/old', content: 'Top adds, September 16, 2025.' },
        { title: 'Evergreen adds', url: 'https://b.example/undated', content: 'Always add depth.' },
      ]),
      now: NOW,
      ollamaApiKey: 'k',
    });
    expect(items.map((i) => i.url)).toEqual(['https://b.example/new']);
  });
});
