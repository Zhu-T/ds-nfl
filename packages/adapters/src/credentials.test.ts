import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeLeague,
  leagueByKey,
  leagueKey,
  leagueSummaries,
  listLeagues,
  readStore,
  rememberLeagueNames,
  removeLeague,
  resolveLeague,
  saveLeague,
  savedEspnCookies,
  setActiveLeague,
  writeStore,
  type LeagueConnection,
} from './credentials.js';

let dir = '';
let path = '';
let previous: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ds-nfl-store-'));
  path = join(dir, 'credentials.json');
  previous = process.env['DS_NFL_CREDENTIALS'];
  process.env['DS_NFL_CREDENTIALS'] = path;
});
afterEach(() => {
  if (previous === undefined) delete process.env['DS_NFL_CREDENTIALS'];
  else process.env['DS_NFL_CREDENTIALS'] = previous;
  rmSync(dir, { recursive: true, force: true });
});

const league = (leagueId: string, extra: Partial<LeagueConnection> = {}): LeagueConnection => ({
  platform: 'espn',
  leagueId,
  teamId: '4',
  season: 2026,
  espnS2: 's2-account-a',
  swid: '{AAAA}',
  ...extra,
});

describe('league store', () => {
  it('starts with nothing connected', () => {
    expect(listLeagues()).toEqual([]);
    expect(activeLeague()).toBeNull();
    expect(resolveLeague()).toBeNull();
  });

  it('keys a league by platform, id, and season', () => {
    expect(leagueKey(league('1'))).toBe('espn:1:2026');
    expect(leagueKey({ leagueId: '1', season: 2025 })).toBe('espn:1:2025');
  });

  it('migrates a single-league store without losing the league or the AI settings', () => {
    writeFileSync(
      path,
      JSON.stringify({
        activePlatform: 'espn',
        espn: { leagueId: '1662', teamId: '4', season: 2026, espnS2: 's2', swid: '{S}' },
        ai: { provider: 'ollama', ollamaModel: 'deepseek-r1:14b' },
      }),
    );
    const store = readStore();
    expect(store.leagues).toEqual([
      { platform: 'espn', leagueId: '1662', teamId: '4', season: 2026, espnS2: 's2', swid: '{S}' },
    ]);
    expect(store.activeLeague).toBe('espn:1662:2026');
    expect(store.ai).toEqual({ provider: 'ollama', ollamaModel: 'deepseek-r1:14b' });
    expect('espn' in store).toBe(false);

    // The next save writes the new shape and drops the old field.
    writeStore(store);
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    expect(onDisk.espn).toBeUndefined();
    expect(onDisk.activePlatform).toBeUndefined();
    expect(onDisk.leagues).toHaveLength(1);
  });

  it('adds leagues, making each new one active', () => {
    saveLeague(league('1'));
    saveLeague(league('2', { teamId: '7' }));
    expect(listLeagues().map(leagueKey)).toEqual(['espn:1:2026', 'espn:2:2026']);
    expect(activeLeague()?.leagueId).toBe('2');
  });

  it('updates a league in place when it is saved again', () => {
    saveLeague(league('1'));
    saveLeague(league('2'));
    saveLeague(league('1', { teamId: '9', leagueName: 'Renamed' }));
    expect(listLeagues().map((l) => [l.leagueId, l.teamId])).toEqual([
      ['1', '9'],
      ['2', '4'],
    ]);
    expect(activeLeague()?.leagueId).toBe('1');
  });

  it('treats a new season of the same league as a separate league', () => {
    saveLeague(league('1', { season: 2025 }));
    saveLeague(league('1', { season: 2026 }));
    expect(listLeagues()).toHaveLength(2);
  });

  it('refreshes cookies on every league of the same ESPN account, and only those', () => {
    saveLeague(league('1'));
    saveLeague(league('2', { swid: '{BBBB}', espnS2: 's2-account-b' }));
    saveLeague(league('3', { espnS2: 's2-account-a-renewed' }));
    expect(leagueByKey('espn:1:2026')?.espnS2).toBe('s2-account-a-renewed');
    expect(leagueByKey('espn:2:2026')?.espnS2).toBe('s2-account-b');
  });

  it('switches the active league, and refuses one that is not connected', () => {
    saveLeague(league('1'));
    saveLeague(league('2'));
    expect(setActiveLeague('espn:1:2026')).toBe(true);
    expect(activeLeague()?.leagueId).toBe('1');
    expect(setActiveLeague('espn:999:2026')).toBe(false);
    expect(activeLeague()?.leagueId).toBe('1');
  });

  it('resolves a named league even when another is active', () => {
    saveLeague(league('1'));
    saveLeague(league('2'));
    expect(resolveLeague('espn:1:2026')?.leagueId).toBe('1');
    expect(resolveLeague()?.leagueId).toBe('2');
    expect(resolveLeague('espn:999:2026')).toBeNull();
  });

  it('removing the active league activates the first remaining one', () => {
    saveLeague(league('1'));
    saveLeague(league('2'));
    saveLeague(league('3'));
    removeLeague('espn:3:2026');
    expect(activeLeague()?.leagueId).toBe('1');
    removeLeague('espn:1:2026');
    expect(listLeagues().map((l) => l.leagueId)).toEqual(['2']);
    expect(activeLeague()?.leagueId).toBe('2');
  });

  it('removing a league that is not active keeps the active one', () => {
    saveLeague(league('1'));
    saveLeague(league('2'));
    removeLeague('espn:1:2026');
    expect(activeLeague()?.leagueId).toBe('2');
  });

  it('removing the last league leaves nothing connected', () => {
    saveLeague(league('1'));
    removeLeague('espn:1:2026');
    expect(activeLeague()).toBeNull();
    expect(readStore().activeLeague).toBeUndefined();
  });

  it('fills in missing names without touching cookies or the active league', () => {
    saveLeague(league('1'));
    saveLeague(league('2'));
    rememberLeagueNames('espn:1:2026', { leagueName: "Tommy's League", teamName: 'My Team' });
    const one = leagueByKey('espn:1:2026');
    expect([one?.leagueName, one?.teamName, one?.espnS2]).toEqual(["Tommy's League", 'My Team', 's2-account-a']);
    expect(activeLeague()?.leagueId).toBe('2');
  });

  it('keeps a known team name when only the league name is supplied', () => {
    saveLeague(league('1', { leagueName: 'Old', teamName: 'My Team' }));
    rememberLeagueNames('espn:1:2026', { leagueName: 'Renamed' });
    expect(leagueByKey('espn:1:2026')).toMatchObject({ leagueName: 'Renamed', teamName: 'My Team' });
  });

  it('ignores a league that is not connected', () => {
    saveLeague(league('1'));
    rememberLeagueNames('espn:999:2026', { leagueName: 'Nope' });
    expect(listLeagues().map((l) => l.leagueName)).toEqual([undefined]);
  });

  it('offers the active league cookies for adding another league', () => {
    expect(savedEspnCookies()).toBeNull();
    saveLeague(league('1'));
    expect(savedEspnCookies()).toEqual({ espnS2: 's2-account-a', swid: '{AAAA}' });
  });

  it('summaries carry names and ids but never the cookies', () => {
    saveLeague(league('1', { leagueName: "Tommy's League", teamName: 'My Team' }));
    saveLeague(league('2'));
    const summaries = leagueSummaries();
    expect(summaries).toEqual([
      {
        key: 'espn:1:2026',
        platform: 'espn',
        leagueId: '1',
        teamId: '4',
        season: 2026,
        leagueName: "Tommy's League",
        teamName: 'My Team',
        active: false,
      },
      {
        key: 'espn:2:2026',
        platform: 'espn',
        leagueId: '2',
        teamId: '4',
        season: 2026,
        leagueName: 'League 2',
        teamName: null,
        active: true,
      },
    ]);
    expect(JSON.stringify(summaries)).not.toMatch(/s2-account|AAAA/);
  });
});
