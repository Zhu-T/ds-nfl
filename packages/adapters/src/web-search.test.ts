import { describe, it, expect, beforeEach } from 'vitest';
import { WebSearchError, gatherPlayerNews, searchOllamaWeb, verifyOllamaSearchKey } from './web-news.js';
import { clearNewsCache } from './espn/news.js';

const NOW = Date.parse('2026-09-17T12:00:00Z');
beforeEach(() => clearNewsCache());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('searchOllamaWeb', () => {
  it('sends the key as a bearer token with the query, and reads the results', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), init: init ?? {} });
      return json({
        results: [
          { title: 'Pitts ruled out', url: 'https://www.espn.com/pitts', content: 'Kyle Pitts is out.' },
          { title: 'no link', url: 'javascript:alert(1)', content: 'x' },
        ],
      });
    }) as typeof fetch;

    const results = await searchOllamaWeb('Kyle Pitts NFL injury news', 'secret-key', { maxResults: 3, fetchImpl });
    expect(seen[0]!.url).toBe('https://ollama.com/api/web_search');
    expect(seen[0]!.init.method).toBe('POST');
    expect((seen[0]!.init.headers as Record<string, string>)['Authorization']).toBe('Bearer secret-key');
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ query: 'Kyle Pitts NFL injury news', max_results: 3 });
    expect(results).toEqual([{ title: 'Pitts ruled out', url: 'https://www.espn.com/pitts', content: 'Kyle Pitts is out.' }]);
  });

  it('turns a rejected key and a rate limit into errors that say so', async () => {
    const auth = await searchOllamaWeb('q', 'bad', { fetchImpl: (async () => json({ error: 'Unauthorized' }, 401)) as typeof fetch }).catch((e: unknown) => e);
    expect(auth).toBeInstanceOf(WebSearchError);
    expect((auth as WebSearchError).kind).toBe('auth');
    expect((auth as Error).message).not.toContain('bad');
    const limit = await searchOllamaWeb('q', 'k', { fetchImpl: (async () => json({}, 429)) as typeof fetch }).catch((e: unknown) => e);
    expect((limit as WebSearchError).kind).toBe('limit');
  });

  it('verifies a key with a one-result search', async () => {
    const bodies: unknown[] = [];
    const fetchImpl = (async (_: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return json({ results: [] });
    }) as typeof fetch;
    await verifyOllamaSearchKey('k', fetchImpl);
    expect(bodies).toEqual([{ query: 'NFL', max_results: 1 }]);
  });
});

describe('gatherPlayerNews with Ollama web search', () => {
  const players = [
    { id: '1', name: 'Kyle Pitts Sr.', position: 'TE' },
    { id: '2', name: 'Tre Tucker', position: 'WR' },
    { id: '3', name: 'Eagles D/ST', position: 'DST' },
  ];

  /** ESPN and Google News return nothing; web search answers per player. */
  function fetchWith(web: (query: string) => Response, calls: string[] = []) {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(url.hostname);
      if (url.hostname === 'site.api.espn.com') return json({ feed: [] });
      if (url.hostname === 'news.google.com') return new Response('<rss><channel></channel></rss>');
      return web(JSON.parse(String(init?.body)).query);
    }) as typeof fetch;
  }

  it('adds page text for results that name the player, labelled by site', async () => {
    const fetchImpl = fetchWith((query) =>
      query.startsWith('Kyle Pitts')
        ? json({
            results: [
              { title: 'Falcons injury report', url: 'https://www.atlantafalcons.com/report', content: '## Report\n[Kyle Pitts](https://x) (hamstring) did **not** practice. Posted Sep 16, 2026.' },
              { title: 'Unrelated', url: 'https://example.com/other', content: 'Nothing about him.' },
            ],
          })
        : json({ results: [] }),
    );

    const result = await gatherPlayerNews(players, { fetchImpl, now: NOW, ollamaApiKey: 'k' });
    expect(result.items).toEqual([
      {
        playerId: '1',
        url: 'https://www.atlantafalcons.com/report',
        source: 'atlantafalcons.com',
        published: '2026-09-16',
        title: 'Falcons injury report',
        text: 'Report Kyle Pitts (hamstring) did not practice. Posted Sep 16, 2026.',
      },
    ]);
    expect(result.sourcesUsed).toEqual(['ESPN', 'Google News', 'Ollama web search']);
    expect(result.warnings).toEqual([]);
    // 3 ESPN lookups, 2 headline searches, 2 web searches (none for a team defense).
    expect(result.requests).toBe(7);
  });

  it('stops after a rejected key and says so, keeping the free sources', async () => {
    const calls: string[] = [];
    const result = await gatherPlayerNews(players, {
      fetchImpl: fetchWith(() => json({ error: 'Unauthorized' }, 401), calls),
      now: NOW,
      ollamaApiKey: 'bad',
      concurrency: 1,
    });
    expect(result.warnings).toEqual(['Ollama rejected the web search key. Check it at ollama.com/settings/keys.']);
    expect(calls.filter((h) => h === 'ollama.com').length).toBeLessThanOrEqual(2);
    expect(calls.filter((h) => h === 'news.google.com').length).toBe(2);
  });

  it('never calls Ollama web search without a key', async () => {
    const calls: string[] = [];
    const result = await gatherPlayerNews(players, { fetchImpl: fetchWith(() => json({ results: [] }), calls), now: NOW });
    expect(calls).not.toContain('ollama.com');
    expect(result.sourcesUsed).toEqual(['ESPN', 'Google News']);
  });
});
