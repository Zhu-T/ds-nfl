import { describe, it, expect, beforeEach } from 'vitest';
import { clearNewsCache, fetchNewsFor, fetchPlayerNews } from './news.js';
import { activeLeague } from '../credentials.js';

const NOW = Date.parse('2026-09-14T12:00:00Z');
const feed = (items: unknown[]) =>
  new Response(JSON.stringify({ feed: items }), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** Serves a scripted feed per player id and counts requests. */
function fakeFeed(byId: Record<string, unknown[] | 'fail'>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const id = new URL(String(input)).searchParams.get('playerId') ?? '';
    calls.push(id);
    const items = byId[id];
    if (items === 'fail') return new Response('nope', { status: 503 });
    return feed(items ?? []);
  }) as typeof fetch;
}

beforeEach(() => clearNewsCache());

describe('fetchPlayerNews', () => {
  it('reads the headline, story, and time, stripping markup', async () => {
    const items = await fetchPlayerNews('42', {
      fetchImpl: fakeFeed({
        '42': [
          {
            type: 'Rotowire',
            id: 1,
            playerId: 42,
            headline: 'Wilson caught <b>five</b> passes.',
            story: '<p>He saw&nbsp;seven targets &amp; a score.</p>',
            published: '2026-09-14T03:08:57Z',
          },
        ],
      }),
    });
    expect(items).toEqual([
      {
        id: '1',
        playerId: '42',
        headline: 'Wilson caught five passes.',
        story: 'He saw seven targets & a score.',
        published: '2026-09-14T03:08:57Z',
      },
    ]);
  });

  it('skips items without a headline', async () => {
    const items = await fetchPlayerNews('42', {
      fetchImpl: fakeFeed({ '42': [{ type: 'Rotowire', id: 1, story: 'no headline', published: '2026-09-14T00:00:00Z' }] }),
    });
    expect(items).toEqual([]);
  });

  it('keeps player blurbs and drops general articles and videos that mention the player', async () => {
    const items = await fetchPlayerNews('42', {
      fetchImpl: fakeFeed({
        '42': [
          { type: 'Story', id: 1, headline: 'Fantasy buzz: the top 10 scorers', published: '2026-09-14T03:00:00Z' },
          { type: 'Rotowire', id: 2, headline: 'Wilson caught five passes.', published: '2026-09-14T02:00:00Z' },
          { type: 'Media', id: 3, headline: 'Why Wilson is the No. 2 option', published: '2026-09-14T01:00:00Z' },
        ],
      }),
    });
    expect(items.map((n) => n.id)).toEqual(['2']);
  });

  it('throws on an HTTP error so the caller can report it', async () => {
    await expect(fetchPlayerNews('42', { fetchImpl: fakeFeed({ '42': 'fail' }) })).rejects.toThrow(/503/);
  });
});

describe('fetchNewsFor', () => {
  const item = (id: number, published: string) => ({ type: 'Rotowire', id, playerId: 1, headline: `h${id}`, published });

  it('keeps only recent items, a few per player', async () => {
    const { byPlayer } = await fetchNewsFor(['1'], {
      now: NOW,
      maxAgeDays: 7,
      perPlayer: 2,
      fetchImpl: fakeFeed({
        '1': [
          item(1, '2026-09-14T03:00:00Z'),
          item(2, '2026-09-12T03:00:00Z'),
          item(3, '2026-09-11T03:00:00Z'),
          item(4, '2026-08-01T03:00:00Z'),
        ],
      }),
    });
    expect(byPlayer.get('1')?.map((n) => n.headline)).toEqual(['h1', 'h2']);
  });

  it('drops stale news entirely rather than listing it', async () => {
    const { byPlayer } = await fetchNewsFor(['1'], {
      now: NOW,
      fetchImpl: fakeFeed({ '1': [item(1, '2026-07-01T00:00:00Z')] }),
    });
    expect(byPlayer.has('1')).toBe(false);
  });

  it('reports a failed player and still returns the others', async () => {
    const result = await fetchNewsFor(['1', '2'], {
      now: NOW,
      fetchImpl: fakeFeed({ '1': [item(1, '2026-09-14T00:00:00Z')], '2': 'fail' }),
    });
    expect(result.byPlayer.get('1')).toHaveLength(1);
    expect(result.failed).toEqual(['2']);
  });

  it('requests each player once even when listed twice', async () => {
    const calls: string[] = [];
    await fetchNewsFor(['1', '1', '2'], { now: NOW, fetchImpl: fakeFeed({}, calls) });
    expect(calls.sort()).toEqual(['1', '2']);
  });
});

// The feed needs no credentials, but like the other live checks it only runs on
// a machine with a connected league, so a clean checkout never needs a network.
const suite = activeLeague() ? describe : describe.skip;
suite('ESPN news feed (live)', () => {
  it('returns well-formed player blurbs for a real player', async () => {
    const items = await fetchPlayerNews('4360761'); // Michael Wilson
    expect(items.length).toBeGreaterThan(0);
    for (const n of items) {
      expect(n.headline.length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(n.published))).toBe(false);
    }
  }, 30_000);
});
