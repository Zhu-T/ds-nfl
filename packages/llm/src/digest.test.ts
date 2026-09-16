import { describe, it, expect } from 'vitest';
import { newsDigestRequest, parseNewsFindings, type DigestItem, type ResearchPlayer } from './research.js';
import { OllamaProvider } from './ollama.js';

const players: ResearchPlayer[] = [
  { id: '1', name: 'Kyle Pitts Sr.', position: 'TE', proTeam: 'ATL', projected: 7.6, role: 'starter' },
  { id: '2', name: 'Deebo Samuel Sr.', position: 'WR', proTeam: 'WSH', projected: 7.4, role: 'bench' },
  { id: '3', name: 'Tre Tucker', position: 'WR', proTeam: 'LV', projected: 8.4, role: 'pickup' },
];

const items: DigestItem[] = [
  { playerId: '1', url: 'https://espn.com/p1', source: 'ESPN', published: '2026-09-17', title: 'Pitts limited Wednesday', text: 'Ankle.' },
  { playerId: '1', url: 'https://news.google.com/a', source: 'NBC Sports', published: '2026-09-16', title: 'Pitts sees one target' },
  { playerId: '3', url: 'https://news.google.com/b', source: 'Raiders', published: '2026-09-17', title: 'Tucker to start' },
];

const report = (findings: unknown[]) => `Done.\n\`\`\`json\n${JSON.stringify({ findings })}\n\`\`\``;

describe('newsDigestRequest', () => {
  const { request, sources } = newsDigestRequest({ leagueName: 'L', week: 2, today: '2026-09-17', players, items });

  it('numbers items in order, under the player they were gathered for', () => {
    expect(request.user).toContain(
      'Kyle Pitts Sr. (TE, ATL): in the recommended lineup, ESPN projects 7.6\n[1] 2026-09-17, ESPN: Pitts limited Wednesday Ankle.\n[2] 2026-09-16, NBC Sports: Pitts sees one target',
    );
    expect(request.user).toContain('Deebo Samuel Sr. (WR, WSH): on the bench, ESPN projects 7.4\n(no news found)');
    expect(request.user).toContain('[3] 2026-09-17, Raiders: Tucker to start');
  });

  it('returns the sources in the same numbered order, tagged with their player', () => {
    expect(sources.map((s) => [s.url, s.about])).toEqual([
      ['https://espn.com/p1', '1'],
      ['https://news.google.com/a', '1'],
      ['https://news.google.com/b', '3'],
    ]);
  });

  it('asks for item numbers, and a context window big enough for the prompt', () => {
    expect(request.system).toContain("the numbers of the items the finding is based on");
    expect(request.system).toContain('A game recap on its own is not a change.');
    expect(request.contextTokens).toBe(8192);
    const many = Array.from({ length: 400 }, (_, i) => ({ ...items[0]!, url: `https://espn.com/${i}`, text: 'x'.repeat(300) }));
    const big = newsDigestRequest({ leagueName: 'L', week: 2, today: 'd', players, items: many }).request;
    expect(big.contextTokens).toBe(32768);
  });
});

describe('parseNewsFindings with numbered sources', () => {
  const { sources } = newsDigestRequest({ leagueName: 'L', week: 2, today: 'd', players, items });

  it('maps item numbers to the gathered sources', () => {
    const { findings } = parseNewsFindings(
      report([{ player: 'Kyle Pitts Sr.', status: 'questionable', factor: 0.8, summary: 'Limited Wednesday.', sources: [1, '[2]'] }]),
      players,
      sources,
      { numbered: true },
    );
    expect(findings[0]!.sources).toEqual([
      { url: 'https://espn.com/p1', title: 'ESPN: Pitts limited Wednesday' },
      { url: 'https://news.google.com/a', title: 'NBC Sports: Pitts sees one target' },
    ]);
  });

  it('rejects a finding that cites only news gathered about another player', () => {
    const { findings, rejected } = parseNewsFindings(
      report([{ player: 'Deebo Samuel Sr.', status: 'out', summary: 'Out.', sources: [3] }]),
      players,
      sources,
      { numbered: true },
    );
    expect(findings).toEqual([]);
    expect(rejected).toEqual([{ player: 'Deebo Samuel Sr.', reason: 'cited news gathered about a different player' }]);
  });

  it('rejects numbers outside the list, and ignores numbers when not in numbered mode', () => {
    const outOfRange = parseNewsFindings(
      report([{ player: 'Tre Tucker', status: 'active', factor: 1.1, summary: 'Starting.', sources: [9] }]),
      players,
      sources,
      { numbered: true },
    );
    expect(outOfRange.rejected[0]!.reason).toBe('cited sources that were never retrieved');
    const urlsOnly = parseNewsFindings(
      report([{ player: 'Tre Tucker', status: 'active', factor: 1.1, summary: 'Starting.', sources: [3] }]),
      players,
      sources,
    );
    expect(urlsOnly.findings).toEqual([]);
  });
});

describe('OllamaProvider context window', () => {
  const capture = () => {
    const bodies: any[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ message: { content: 'ok' } }), { status: 200 });
    }) as typeof fetch;
    return { bodies, provider: new OllamaProvider('deepseek-r1:14b', undefined, fetchImpl) };
  };

  it('asks for the window a request needs, and a safe default otherwise', async () => {
    const { bodies, provider } = capture();
    await provider.complete({ system: 'S', user: 'U', contextTokens: 16384 });
    await provider.complete({ system: 'S', user: 'U' });
    expect(bodies[0].options.num_ctx).toBe(16384);
    expect(bodies[1].options.num_ctx).toBe(8192);
  });
});
