/**
 * Recording weekly results as the app runs: what it believed before kickoff,
 * and once a week is over, what actually happened. See
 * packages/adapters/src/results.ts for the files, and `npm run export-results`
 * for the training export.
 *
 * Recording is a side job: nothing here slows or breaks a page. Snapshots are
 * small synchronous writes, throttled; results are built in the background.
 */

import 'server-only';
import {
  mergeSnapshot,
  readNewsReport,
  readSnapshot,
  readWebPicks,
  readWeekResults,
  writeSnapshot,
  writeWeekResults,
  type EspnReader,
  type LeagueInfo,
  type LeagueRef,
  type PlayerSnapshot,
  type ResultOwnerKind,
  type RosterPlayer,
} from '@ds-nfl/adapters';
import type { OptimizerPlayer } from '@ds-nfl/core';
import { summarizeWeek } from './results-summary';

/** A page's snapshot is rewritten at most this often, unless its set of players changes. */
const SNAPSHOT_EVERY_MS = 10 * 60 * 1000;
const lastSnapshot = new Map<string, { at: number; count: number }>();

/** One player as the app priced them: ESPN's number, the app's, and each adjustment. */
export function snapshotRow(
  p: OptimizerPlayer,
  rp: RosterPlayer | undefined,
  ownerKind: ResultOwnerKind,
  extra: { readonly slot?: string; readonly gain?: number; readonly horizonGain?: number } = {},
): PlayerSnapshot {
  return {
    id: p.gsisId,
    name: p.name,
    position: p.position,
    proTeam: rp?.proTeam ?? null,
    ownerKind,
    espn: rp?.projectedPoints ?? p.projectedPoints,
    projected: p.projectedPoints,
    ...(p.market ? { market: p.market.blended } : {}),
    ...(p.matchup ? { matchupFactor: p.matchup.factor } : {}),
    ...(p.form ? { formFactor: p.form.factor } : {}),
    ...(p.news ? { news: { status: p.news.status, factor: p.news.factor } } : {}),
    ...(extra.slot !== undefined ? { slot: extra.slot } : {}),
    ...(extra.gain !== undefined ? { gain: extra.gain } : {}),
    ...(extra.horizonGain !== undefined ? { horizonGain: extra.horizonGain } : {}),
    capturedAt: new Date().toISOString(),
    // Locked, or already scoring: the game has started.
    beforeKickoff: !(rp?.locked ?? false) && rp?.actualPoints === undefined,
  };
}

/** Merge a page's priced players into the week's snapshot, throttled per page. Never throws. */
export function recordSnapshot(key: string, week: number, source: string, rows: readonly PlayerSnapshot[]): void {
  if (rows.length === 0) return;
  const k = `${key}:${week}:${source}`;
  const last = lastSnapshot.get(k);
  if (last && Date.now() - last.at < SNAPSHOT_EVERY_MS && last.count === rows.length) return;
  try {
    writeSnapshot(mergeSnapshot(readSnapshot(key, week), key, week, rows));
    lastSnapshot.set(k, { at: Date.now(), count: rows.length });
  } catch {
    // A failed write only loses one snapshot; the next page load tries again.
  }
}

const recording = new Set<string>();

/**
 * Results for every finished week that has none yet, oldest first. Weeks from
 * before recording began get ESPN's projections alone. Runs in the background
 * and never throws.
 */
export async function recordCompletedWeeks(reader: EspnReader, ref: LeagueRef, league: LeagueInfo, key: string): Promise<void> {
  if (recording.has(key)) return;
  recording.add(key);
  try {
    for (let week = 1; week < league.currentWeek; week++) {
      if (readWeekResults(key, week)) continue;
      writeWeekResults(await weekResults(reader, ref, league, key, week));
    }
  } catch {
    // Tried again on the next page load.
  } finally {
    recording.delete(key);
  }
}

async function weekResults(reader: EspnReader, ref: LeagueRef, league: LeagueInfo, key: string, week: number) {
  const snapshot = readSnapshot(key, week);
  const all = await reader.getAllRosters(ref, week);
  const myId = String(ref.teamId);
  const rostered = [...all].flatMap(([teamId, players]) =>
    players.map((player) => ({ player, ownerKind: (String(teamId) === myId ? 'mine' : 'team') as 'mine' | 'team' })),
  );
  const onRosters = new Set(rostered.map((r) => r.player.platformPlayerId));
  const otherIds = Object.keys(snapshot?.players ?? {}).filter((id) => !onRosters.has(id));
  const others = otherIds.length > 0 ? await reader.getPlayersByIds(ref, week, otherIds) : [];
  const report = readNewsReport(key, week);
  const picks = readWebPicks(key, week);
  return summarizeWeek({
    leagueKey: key,
    week,
    settings: league.rosterSettings,
    rostered,
    others,
    snapshot,
    findings: (report?.findings ?? []).map((f) => ({
      playerId: f.playerId,
      status: f.status,
      factor: f.factor,
      summary: f.summary,
      used: !report!.disabled.includes(f.playerId),
    })),
    pickedIds: new Set((picks?.picks ?? []).flatMap((p) => (p.playerId ? [p.playerId] : []))),
  });
}
