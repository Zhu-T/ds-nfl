import { describe, it, expect } from 'vitest';
import type { PlayerResult, PlayerSnapshot, WeekResults } from '@ds-nfl/adapters';
import { reviewResults } from './accuracy';

const snap = (extra: Partial<PlayerSnapshot> = {}): PlayerSnapshot => ({
  id: 'x',
  name: 'x',
  position: 'WR',
  proTeam: 'DET',
  ownerKind: 'mine',
  espn: 10,
  projected: 10,
  capturedAt: 'then',
  beforeKickoff: true,
  ...extra,
});

const row = (id: string, actual: number | null, app: PlayerSnapshot | undefined, extra: Partial<PlayerResult> = {}): PlayerResult => ({
  id,
  name: id,
  position: 'WR',
  proTeam: 'DET',
  ownerKind: 'mine',
  espn: 10,
  actual,
  ...(app ? { app: { ...app, id, name: id } } : {}),
  ...extra,
});

const week = (n: number, players: PlayerResult[], lineup: WeekResults['lineup']): WeekResults => ({
  leagueKey: 'k',
  week: n,
  recordedAt: 'now',
  snapshotted: players.some((p) => p.app),
  lineup,
  players,
});

describe('reviewResults', () => {
  it('totals each week and what the bench outscored the lineup by', () => {
    const r = reviewResults([
      week(2, [], { set: 100, recommended: 104, recommendedFrom: 'app', best: 120 }),
      week(1, [], { set: 90, recommended: 88, recommendedFrom: 'espn', best: 99 }),
    ]);
    expect(r.weeks.map((w) => [w.week, w.leftOnBench])).toEqual([
      [1, 9],
      [2, 20],
    ]);
    expect(r.totals).toEqual({ set: 190, recommended: 192, best: 219 });
  });

  it('grades each adjustment on its own, and ignores players priced after kickoff', () => {
    const r = reviewResults([
      week(
        1,
        [
          // Betting lines moved 10 to 14; the player scored 15, so they helped by 4.
          row('lines', 15, snap({ espn: 10, projected: 14, market: 14 })),
          // Form cut 10 to 9 (x0.9); the player scored 12, so it hurt by 1.
          row('form', 12, snap({ espn: 10, projected: 9, formFactor: 0.9 })),
          // The opponent model raised a D/ST 8 to 9.6; it scored 10, so it helped by 1.6.
          row('dst', 10, snap({ espn: 8, projected: 9.6, matchupFactor: 1.2 })),
          // Not counted: no snapshot, taken after kickoff, or never played.
          row('none', 20, undefined),
          row('late', 30, snap({ projected: 12, market: 12, beforeKickoff: false })),
          row('bye', null, snap({ projected: 12, market: 12 })),
        ],
        null,
      ),
    ]);
    expect(r.projections.players).toBe(3);
    const by = Object.fromEntries(r.adjustments.map((a) => [a.key, a]));
    expect(by['market']).toMatchObject({ players: 1, without: 5, with: 1, better: 4 });
    expect(by['form']).toMatchObject({ players: 1, better: -1 });
    expect(by['matchup']).toMatchObject({ players: 1, better: 1.6 });
  });

  it('grades news findings by direction, web picks against the pool, and ceilings by how often they are beaten', () => {
    const r = reviewResults([
      week(
        1,
        [
          row('cut', 4, snap({ espn: 12, projected: 6, ceiling: 20 }), { news: { status: 'questionable', factor: 0.5, summary: 's', used: true } }),
          row('raised', 6, snap({ espn: 8, projected: 10, ceiling: 22 }), { news: { status: 'role change', factor: 1.25, summary: 's', used: true } }),
          row('ignored', 30, snap({ espn: 8, projected: 8, ceiling: 15 }), { news: { status: 'out', factor: 0, summary: 's', used: false } }),
          row('pick', 18, snap({ ceiling: 16 }), { ownerKind: 'waivers', webPick: true }),
          row('other', 6, snap({ ceiling: 16 }), { ownerKind: 'free-agent' }),
        ],
        null,
      ),
    ]);
    // The cut was right (scored under ESPN's number); the raise was wrong; the ignored one is not counted.
    expect(r.news).toEqual({ findings: 2, right: 1 });
    expect(r.picks).toEqual({ picks: 1, picked: 18, pool: 12 });
    expect(r.ceilings).toEqual({ players: 5, beat: 2 });
  });
});
