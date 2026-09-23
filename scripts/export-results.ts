/**
 * Every recorded week as training and analysis data: one JSON row per player
 * per week, and one per lineup per week.
 *
 *   npm run export-results                  the dev data folder, data/
 *   npm run export-results -- "<folder>"    another, e.g. the desktop app's %APPDATA%\ds-nfl
 *
 * Writes <folder>/results/player-weeks.jsonl and lineup-weeks.jsonl.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listWeekResults } from '../packages/adapters/src/results.js';

const dir = join(resolve(process.argv[2] ?? 'data'), 'results');
const weeks = listWeekResults(dir);

const players = weeks.flatMap((w) =>
  w.players.map((p) => ({
    league: w.leagueKey,
    week: w.week,
    id: p.id,
    name: p.name,
    position: p.position,
    proTeam: p.proTeam,
    ownerKind: p.ownerKind,
    setSlot: p.setSlot ?? null,
    actual: p.actual,
    espn: p.espn,
    appProjected: p.app?.projected ?? null,
    market: p.app?.market ?? null,
    matchupFactor: p.app?.matchupFactor ?? null,
    formFactor: p.app?.formFactor ?? null,
    sd: p.app?.sd ?? null,
    ceiling: p.app?.ceiling ?? null,
    rostered: p.app?.rostered ?? null,
    rosteredChange: p.app?.rosteredChange ?? null,
    recommendedSlot: p.app?.slot ?? null,
    gain: p.app?.gain ?? null,
    horizonGain: p.app?.horizonGain ?? null,
    beforeKickoff: p.app?.beforeKickoff ?? null,
    newsStatus: p.news?.status ?? null,
    newsFactor: p.news?.factor ?? null,
    newsUsed: p.news?.used ?? null,
    newsSummary: p.news?.summary ?? null,
    webPick: p.webPick ?? false,
  })),
);
const lineups = weeks.flatMap((w) => (w.lineup ? [{ league: w.leagueKey, week: w.week, snapshotted: w.snapshotted, ...w.lineup }] : []));

const lines = (rows: readonly unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : '');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'player-weeks.jsonl'), lines(players), 'utf8');
writeFileSync(join(dir, 'lineup-weeks.jsonl'), lines(lineups), 'utf8');
console.log(`${weeks.length} recorded weeks: ${players.length} player rows and ${lineups.length} lineup rows written to ${dir}`);
