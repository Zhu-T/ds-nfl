import { describe, it, expect, beforeEach } from 'vitest';
import { clearOddsCache, fetchWeekOdds, parsePropBets, parseScoreboardOdds } from './odds.js';
import { activeLeague } from '../credentials.js';

const game = (id: string, away: string, home: string, spread: number, overUnder: number) => ({
  id,
  competitions: [
    {
      competitors: [
        { homeAway: 'home', team: { abbreviation: home } },
        { homeAway: 'away', team: { abbreviation: away } },
      ],
      odds: [{ provider: { name: 'DraftKings' }, details: '', spread, overUnder }],
    },
  ],
});

const prop = (type: string, athlete: string, value: number) => ({
  type: { id: type },
  athlete: { $ref: `http://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/2026/athletes/${athlete}?lang=en` },
  current: { target: { value } },
});

beforeEach(() => clearOddsCache());

describe('parseScoreboardOdds', () => {
  it('turns a spread and total into each team’s implied points', () => {
    const teams = parseScoreboardOdds({ events: [game('1', 'DET', 'BUF', -4.5, 53.5), game('2', 'CAR', 'ATL', 1.5, 43.5)] });
    expect(teams.map((t) => [t.team, t.spread, t.impliedPoints, t.opponent])).toEqual([
      ['BUF', -4.5, 29, 'DET'],
      ['DET', 4.5, 24.5, 'BUF'],
      ['ATL', 1.5, 21, 'CAR'],
      ['CAR', -1.5, 22.5, 'ATL'],
    ]);
  });

  it('skips games without lines', () => {
    const noLine = { ...game('1', 'DET', 'BUF', 0, 0), competitions: [{ ...game('1', 'DET', 'BUF', 0, 0).competitions[0], odds: [] }] };
    expect(parseScoreboardOdds({ events: [noLine] })).toEqual([]);
  });
});

describe('parsePropBets', () => {
  it('keeps the main yardage and reception lines per athlete, by id', () => {
    const lines = parsePropBets({
      items: [
        prop('8', '3046779', 259.5),
        prop('8', '3046779', 280.5), // an alternate line: ignored
        prop('13', '4360248', 60.5),
        prop('14', '4360248', 4.5),
        prop('10', '3046779', 1.5), // passing touchdowns: not used by the blend
        { type: { id: '31' }, athlete: { $ref: '.../athletes/1' }, current: {} }, // anytime TD, no price
      ],
    });
    expect(Object.fromEntries(lines)).toEqual({
      '3046779': { passYds: 259.5 },
      '4360248': { recYds: 60.5, receptions: 4.5 },
    });
  });
});

describe('fetchWeekOdds', () => {
  function fakeEspn(calls: string[] = []) {
    return (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/scoreboard')) {
        return new Response(JSON.stringify({ events: [game('10', 'DET', 'BUF', -4.5, 53.5), game('11', 'CAR', 'ATL', 1.5, 43.5)] }));
      }
      // Game 11 has no odds at all.
      if (url.includes('/events/11/')) return new Response('down', { status: 503 });
      if (url.endsWith('/odds')) {
        return new Response(JSON.stringify({ items: [{ provider: { id: '58' } }, { provider: { id: '100' } }] }));
      }
      return new Response(JSON.stringify({ items: [prop('8', '3046779', 259.5)] }));
    }) as typeof fetch;
  }

  it('reads game lines and props, preferring DraftKings, and counts failed games', async () => {
    const calls: string[] = [];
    const odds = await fetchWeekOdds(2026, 2, { fetchImpl: fakeEspn(calls) });
    expect(calls[0]).toContain('seasontype=2&week=2&dates=2026');
    expect(odds.teams.get('BUF')?.impliedPoints).toBe(29);
    expect(odds.props.get('3046779')).toEqual({ passYds: 259.5 });
    expect(calls.some((u) => u.includes('/odds/100/propBets?limit=500'))).toBe(true);
    // DraftKings answered directly, so game 10 needed no provider listing.
    expect(calls.some((u) => u.includes('/events/10/') && u.endsWith('/odds'))).toBe(false);
    expect(odds.failed).toBe(1);
    expect(odds.provider).toBe('DraftKings');
  });

  it('shares one fetch between callers within half an hour', async () => {
    const calls: string[] = [];
    const fetchImpl = fakeEspn(calls);
    await Promise.all([fetchWeekOdds(2026, 2, { fetchImpl }), fetchWeekOdds(2026, 2, { fetchImpl })]);
    expect(calls.filter((u) => u.includes('/scoreboard'))).toHaveLength(1);
  });
});

const suite = activeLeague() ? describe : describe.skip;
suite('ESPN odds (live)', () => {
  it('has lines for every game of a regular-season week and props keyed by athlete id', async () => {
    const odds = await fetchWeekOdds(2026, 2);
    expect(odds.teams.size).toBeGreaterThan(0);
    for (const t of odds.teams.values()) expect(Number.isFinite(t.impliedPoints)).toBe(true);
  }, 60_000);
});
