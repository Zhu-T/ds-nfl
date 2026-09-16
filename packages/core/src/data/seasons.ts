/**
 * Which seasons of data to use, per dataset.
 *
 * The fantasy season starts before the NFL season produces any data, so some
 * datasets must fall back to prior years. The previous implementation applied
 * that fallback *globally* ("step back a year when the frame is empty"), which
 * is correct for production stats and actively dangerous for structural data:
 * falling back on schedules would hand you last season's bye weeks and last
 * season's opponents, which is wrong in a way that looks entirely plausible.
 *
 * Measured on 2026-09-13 (Week 1 in progress) to justify the split below:
 *
 *   schedules/games      272 games, all 18 weeks published  -> current season
 *   weekly_rosters       2,963 rows                         -> current season
 *   injuries             182 rows, sparse                   -> current season
 *   stats_player_week    135 rows (2025 had 19,422)         -> prior seasons
 */

export type Dataset = 'schedules' | 'rosters' | 'injuries' | 'weeklyStats';

export interface SeasonContext {
  /** The fantasy season being played, e.g. 2026. */
  readonly season: number;
  /** Current NFL week, 1-based. 0 means preseason. */
  readonly week: number;
}

/**
 * Completed weeks needed before a player's own current-season usage should
 * outweigh their prior-season baseline. Below this, the sample is noise.
 */
export const MIN_WEEKS_FOR_CURRENT_SEASON_STATS = 4;

/** Seasons of history used for usage and efficiency priors. */
export const HISTORY_SEASONS = 3;

export interface SeasonResolution {
  /** Seasons to load, most recent first. */
  readonly seasons: readonly number[];
  /** Whether the current season contributes usable production data. */
  readonly currentSeasonUsable: boolean;
  /** Why — surfaced in the UI so a projection's basis is never a mystery. */
  readonly reason: string;
}

export function resolveSeasons(dataset: Dataset, ctx: SeasonContext): SeasonResolution {
  switch (dataset) {
    // Structural data for the current season is authoritative the moment it
    // exists, and must never fall back — wrong bye weeks are silent corruption.
    case 'schedules':
    case 'rosters':
      return {
        seasons: [ctx.season],
        currentSeasonUsable: true,
        reason: `${dataset} for ${ctx.season} are published in advance; falling back would yield the wrong byes and opponents`,
      };

    // Injury reports only describe the present. An empty file early in the
    // season means "nobody is hurt yet", not "fall back to last year".
    case 'injuries':
      return {
        seasons: [ctx.season],
        currentSeasonUsable: true,
        reason: `injury reports are only meaningful for the current season`,
      };

    case 'weeklyStats': {
      const history = Array.from({ length: HISTORY_SEASONS }, (_, i) => ctx.season - 1 - i);
      const usable = ctx.week >= MIN_WEEKS_FOR_CURRENT_SEASON_STATS;
      return {
        seasons: usable ? [ctx.season, ...history] : history,
        currentSeasonUsable: usable,
        reason: usable
          ? `week ${ctx.week}: current-season usage has enough sample to contribute`
          : `week ${ctx.week}: fewer than ${MIN_WEEKS_FOR_CURRENT_SEASON_STATS} weeks played, using ${history[0]}-${history[history.length - 1]} as the basis`,
      };
    }
  }
}

/**
 * How much to weight the platform's own projection (ESPN's `statSourceId: 1`)
 * against our usage-based model.
 *
 * Early in a season we have no current-season usage at all, and ESPN's number
 * already reflects offseason moves, depth-chart changes, and coaching turnover
 * that a purely historical model cannot see. As real usage accumulates, our
 * model earns the weight. Never goes to zero — it stays a useful check.
 */
export function platformProjectionWeight(week: number): number {
  const START = 0.8;
  const FLOOR = 0.2;
  const DECAY_PER_WEEK = 0.12;
  const weeksPlayed = Math.max(0, week - 1);
  return Math.min(START, Math.max(FLOOR, START - weeksPlayed * DECAY_PER_WEEK));
}
