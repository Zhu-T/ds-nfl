/**
 * The app graded against what happened, from the weeks recorded in
 * data/results (see packages/adapters/src/results.ts).
 *
 * Each adjustment is judged on its own: the projection as it went out is
 * compared with the same projection without that one factor, and both against
 * the actual score. Only players priced before kickoff count, so nothing is
 * scored with hindsight. Pure, so it can be tested.
 */

import type { PlayerResult, PlayerSnapshot, WeekResults } from '@ds-nfl/adapters';

/** How a week ended, and whether a better lineup would have ended it differently. */
export interface WeekOutcome {
  readonly opponent: string;
  readonly myScore: number;
  readonly opponentScore: number;
  readonly outcome: 'won' | 'lost' | 'tied';
  /** For a week you did not win: whether these would have beaten that score. */
  readonly recommendedWins: boolean;
  readonly bestWins: boolean;
}

export interface WeekReview {
  readonly week: number;
  /** False for weeks from before recording began: ESPN's projections only. */
  readonly snapshotted: boolean;
  readonly set: number;
  readonly recommended: number;
  readonly recommendedFrom: 'app' | 'espn';
  readonly best: number;
  /** What the bench outscored the lineup by: best − set. */
  readonly leftOnBench: number;
  /** Absent for weeks with no opponent, and for weeks recorded before this was kept. */
  readonly outcome?: WeekOutcome;
}

export interface AdjustmentVerdict {
  readonly key: 'market' | 'matchup' | 'form';
  readonly label: string;
  /** Player-weeks where the adjustment moved a projection. */
  readonly players: number;
  /** Mean absolute error without it, and with it. */
  readonly without: number;
  readonly with: number;
  /** Points of error it removed per player-week; negative means it hurt. */
  readonly better: number;
}

export interface NewsReview {
  readonly findings: number;
  /** Findings whose direction matched what happened. */
  readonly right: number;
}

export interface PickReview {
  readonly picks: number;
  /** Mean points scored by web picks, and by everyone available at the same positions. */
  readonly picked: number;
  readonly pool: number;
}

export interface Accuracy {
  readonly weeks: readonly WeekReview[];
  readonly totals: { readonly set: number; readonly recommended: number; readonly best: number };
  /**
   * Your record over the graded weeks, and the losses a better lineup would
   * have turned around. Weeks with no recorded opponent are left out of it.
   */
  readonly record: {
    readonly won: number;
    readonly lost: number;
    readonly tied: number;
    /** Losses the recommended lineup would have won, and the best possible one. */
    readonly recommendedWins: number;
    readonly bestWins: number;
  };
  /** Every player the app priced before kickoff: ESPN's error against the app's. */
  readonly projections: { readonly players: number; readonly espn: number; readonly app: number };
  readonly adjustments: readonly AdjustmentVerdict[];
  readonly news: NewsReview;
  readonly picks: PickReview;
  /** Players who beat their ceiling; about one in ten is right. */
  readonly ceilings: { readonly players: number; readonly beat: number };
}

/** Below this many player-weeks, a verdict is noise; the page says so rather than showing it. */
export const ENOUGH_PLAYERS = 40;

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const mean = (xs: readonly number[]) => (xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

/** A player priced before kickoff, who then played. */
interface Scored {
  readonly actual: number;
  readonly app: PlayerSnapshot;
  readonly row: PlayerResult;
}

function scored(weeks: readonly WeekResults[]): Scored[] {
  return weeks.flatMap((w) =>
    w.players.flatMap((row) =>
      row.actual !== null && row.app && row.app.beforeKickoff ? [{ actual: row.actual, app: row.app, row }] : [],
    ),
  );
}

/**
 * The projection without one adjustment. Betting lines replace ESPN's number,
 * so without them it is ESPN's; the matchup and form scale it, so dividing
 * takes them back out.
 */
function without(app: PlayerSnapshot, key: AdjustmentVerdict['key']): number | null {
  if (key === 'market') return app.market === undefined ? null : app.espn;
  const factor = key === 'matchup' ? app.matchupFactor : app.formFactor;
  return factor === undefined || factor === 1 || factor === 0 ? null : app.projected / factor;
}

const LABELS: Record<AdjustmentVerdict['key'], string> = {
  market: 'Betting lines',
  matchup: 'Opponent (D/ST)',
  form: 'Recent form',
};

/**
 * A week's result, and the counterfactuals.
 *
 * The verdict uses the league's own totals, since those are what counted. The
 * counterfactuals compare a lineup's actual points against the opponent's
 * score: changing your lineup would not have changed theirs.
 */
function outcomeOf(
  matchup: NonNullable<WeekResults['matchup']>,
  lineup: NonNullable<WeekResults['lineup']>,
): WeekOutcome {
  return {
    opponent: matchup.opponent,
    myScore: matchup.myScore,
    opponentScore: matchup.opponentScore,
    outcome:
      matchup.myScore > matchup.opponentScore ? 'won' : matchup.myScore < matchup.opponentScore ? 'lost' : 'tied',
    recommendedWins: lineup.recommended > matchup.opponentScore,
    bestWins: lineup.best > matchup.opponentScore,
  };
}

export function reviewResults(results: readonly WeekResults[]): Accuracy {
  const weeks = [...results].sort((a, b) => a.week - b.week);
  const rows = scored(weeks);

  const adjustments = (['market', 'matchup', 'form'] as const).map((key) => {
    const applied = rows.flatMap((r) => {
      const base = without(r.app, key);
      return base === null ? [] : [{ withErr: Math.abs(r.actual - r.app.projected), withoutErr: Math.abs(r.actual - base) }];
    });
    const withIt = mean(applied.map((a) => a.withErr));
    const withoutIt = mean(applied.map((a) => a.withoutErr));
    return {
      key,
      label: LABELS[key],
      players: applied.length,
      without: round2(withoutIt),
      with: round2(withIt),
      better: round2(withoutIt - withIt),
    };
  });

  const findings = rows.flatMap((r) => (r.row.news?.used ? [{ ...r, news: r.row.news! }] : []));
  const picks = rows.filter((r) => r.row.webPick);
  const pickPositions = new Set(picks.map((p) => p.row.position));
  const pool = rows.filter(
    (r) => (r.row.ownerKind === 'waivers' || r.row.ownerKind === 'free-agent') && pickPositions.has(r.row.position),
  );
  const ceilings = rows.filter((r) => r.app.ceiling !== undefined);

  const reviewed = weeks.flatMap((w) =>
    w.lineup
      ? [
          {
            week: w.week,
            snapshotted: w.snapshotted,
            set: w.lineup.set,
            recommended: w.lineup.recommended,
            recommendedFrom: w.lineup.recommendedFrom,
            best: w.lineup.best,
            leftOnBench: round1(w.lineup.best - w.lineup.set),
            ...(w.matchup ? { outcome: outcomeOf(w.matchup, w.lineup) } : {}),
          },
        ]
      : [],
  );
  const decided = reviewed.flatMap((w) => (w.outcome ? [w.outcome] : []));
  const notWon = decided.filter((o) => o.outcome !== 'won');

  return {
    weeks: reviewed,
    record: {
      won: decided.filter((o) => o.outcome === 'won').length,
      lost: decided.filter((o) => o.outcome === 'lost').length,
      tied: decided.filter((o) => o.outcome === 'tied').length,
      recommendedWins: notWon.filter((o) => o.recommendedWins).length,
      bestWins: notWon.filter((o) => o.bestWins).length,
    },
    totals: {
      set: round1(weeks.reduce((s, w) => s + (w.lineup?.set ?? 0), 0)),
      recommended: round1(weeks.reduce((s, w) => s + (w.lineup?.recommended ?? 0), 0)),
      best: round1(weeks.reduce((s, w) => s + (w.lineup?.best ?? 0), 0)),
    },
    projections: {
      players: rows.length,
      espn: round2(mean(rows.map((r) => Math.abs(r.actual - r.app.espn)))),
      app: round2(mean(rows.map((r) => Math.abs(r.actual - r.app.projected)))),
    },
    adjustments,
    news: {
      findings: findings.length,
      // A finding that cut a projection should have been followed by a poor game, and the other way round.
      right: findings.filter((f) => (f.news.factor < 1 ? f.actual < f.app.espn : f.actual > f.app.espn)).length,
    },
    picks: {
      picks: picks.length,
      picked: round1(mean(picks.map((p) => p.actual))),
      pool: round1(mean(pool.map((p) => p.actual))),
    },
    ceilings: { players: ceilings.length, beat: ceilings.filter((r) => r.actual > r.app.ceiling!).length },
  };
}
