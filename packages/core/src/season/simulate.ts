/**
 * Playoff odds: the rest of the season played out many times.
 *
 * Each remaining matchup draws a score for both teams from the same model the
 * week's win chance uses (a normal around what their lineup projects, with the
 * spread their players carry; see ceiling/win.ts). Records are then carried to
 * the end and seeded the way ESPN does it: wins first, points for as the
 * tiebreak.
 *
 * The randomness is seeded, so the same inputs always give the same odds and
 * tests can be exact.
 */

import type { SeasonMatchup } from '../types.js';

export interface SimTeam {
  readonly teamId: string;
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  readonly pointsFor: number;
  /** What this team scores in a week from here on. */
  readonly mean: number;
  readonly sd: number;
}

export interface SeasonOdds {
  readonly teamId: string;
  /** Share of seasons this team reaches the playoffs, 0 to 1. */
  readonly playoffs: number;
  readonly averageWins: number;
  readonly averageSeed: number;
}

export interface WeekImportance {
  readonly week: number;
  readonly opponentTeamId: string;
  readonly winProbability: number;
  /** Playoff odds in the seasons this week was won, and lost. */
  readonly playoffsIfWin: number;
  readonly playoffsIfLose: number;
}

export interface SeasonSimulation {
  readonly runs: number;
  readonly odds: readonly SeasonOdds[];
  /** For the team asked about: what each remaining week is worth. */
  readonly importance: readonly WeekImportance[];
}

export interface SimInput {
  readonly teams: readonly SimTeam[];
  /** Matchups still to play, in any order. */
  readonly remaining: readonly SeasonMatchup[];
  readonly playoffTeams: number;
  /** The team whose weeks are weighed; usually yours. */
  readonly teamId?: string;
  readonly runs?: number;
  readonly seed?: number;
}

export const DEFAULT_RUNS = 20_000;

/** mulberry32: small, fast, and good enough for counting wins. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, one value per call; the second is kept for the next one. */
function normals(next: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    const u = Math.max(next(), 1e-12);
    const v = next();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

export function simulateSeason(input: SimInput): SeasonSimulation {
  const runs = input.runs ?? DEFAULT_RUNS;
  const next = rng(input.seed ?? 20_260_101);
  const normal = normals(next);
  const teams = input.teams;
  const index = new Map(teams.map((t, i) => [t.teamId, i]));
  const played = input.remaining.filter((m) => index.has(m.homeTeamId) && index.has(m.awayTeamId));
  const mineIndex = input.teamId !== undefined ? index.get(input.teamId) : undefined;
  const myGames = mineIndex === undefined ? [] : played.filter((m) => m.homeTeamId === input.teamId || m.awayTeamId === input.teamId);

  const madePlayoffs = new Array(teams.length).fill(0);
  const seedTotal = new Array(teams.length).fill(0);
  const winTotal = new Array(teams.length).fill(0);
  // Per remaining game of the team asked about: wins, and playoff seasons within wins and losses.
  const won = new Array(myGames.length).fill(0);
  const playoffsWhenWon = new Array(myGames.length).fill(0);
  const playoffsWhenLost = new Array(myGames.length).fill(0);

  const wins = new Float64Array(teams.length);
  const points = new Float64Array(teams.length);
  // Which of the team's own games each remaining matchup is, so the outcome can be read back.
  const mySlot = new Int32Array(played.length).fill(-1);
  for (let k = 0; k < myGames.length; k++) mySlot[played.indexOf(myGames[k]!)] = k;
  const myWon = new Uint8Array(myGames.length);
  const order = teams.map((_, i) => i);

  for (let run = 0; run < runs; run++) {
    for (let i = 0; i < teams.length; i++) {
      wins[i] = teams[i]!.wins + teams[i]!.ties * 0.5;
      points[i] = teams[i]!.pointsFor;
    }
    for (let g = 0; g < played.length; g++) {
      const m = played[g]!;
      const h = index.get(m.homeTeamId)!;
      const a = index.get(m.awayTeamId)!;
      const hs = teams[h]!.mean + normal() * teams[h]!.sd;
      const as = teams[a]!.mean + normal() * teams[a]!.sd;
      points[h]! += hs;
      points[a]! += as;
      if (hs > as) wins[h]! += 1;
      else if (as > hs) wins[a]! += 1;
      else {
        wins[h]! += 0.5;
        wins[a]! += 0.5;
      }
      const slot = mySlot[g]!;
      if (slot >= 0) myWon[slot] = (mineIndex === h ? hs > as : as > hs) ? 1 : 0;
    }

    order.sort((x, y) => wins[y]! - wins[x]! || points[y]! - points[x]!);
    let mineMadeIt = false;
    for (let seed = 0; seed < order.length; seed++) {
      const team = order[seed]!;
      seedTotal[team] += seed + 1;
      winTotal[team] += wins[team]!;
      if (seed < input.playoffTeams) {
        madePlayoffs[team] += 1;
        if (team === mineIndex) mineMadeIt = true;
      }
    }
    // What each of your own games was worth: the playoff rate in the seasons you won it,
    // against the seasons you lost it.
    for (let k = 0; k < myGames.length; k++) {
      if (myWon[k]) {
        won[k] += 1;
        if (mineMadeIt) playoffsWhenWon[k] += 1;
      } else if (mineMadeIt) {
        playoffsWhenLost[k] += 1;
      }
    }
  }

  return {
    runs,
    odds: teams.map((t, i) => ({
      teamId: t.teamId,
      playoffs: madePlayoffs[i] / runs,
      averageWins: winTotal[i] / runs,
      averageSeed: seedTotal[i] / runs,
    })),
    importance: myGames.map((m, k) => ({
      week: m.week,
      opponentTeamId: m.homeTeamId === input.teamId ? m.awayTeamId : m.homeTeamId,
      winProbability: won[k] / runs,
      playoffsIfWin: won[k] > 0 ? playoffsWhenWon[k] / won[k] : 0,
      playoffsIfLose: runs - won[k] > 0 ? playoffsWhenLost[k] / (runs - won[k]) : 0,
    })),
  };
}
