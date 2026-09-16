/**
 * ESPN scoring.
 *
 * ESPN hands us both halves of the calculation: `scoringItems` maps a statId to
 * points, and every stats entry carries a raw `stats` map of statId to value.
 * Scoring is therefore the dot product of the two — we never need to know what
 * a statId *means* to score an ESPN stat line correctly.
 *
 * That matters because ESPN publishes no statId dictionary. The previous
 * implementation read exactly one statId (53, receptions) to decide whether a
 * league was PPR and discarded the other 45 rules in this league alone,
 * including a non-standard 5-point passing touchdown.
 *
 * Verified against the live league: 981 of 981 player-week entries reproduce
 * ESPN's own `appliedTotal` to within 0.02. See scoring.test.ts.
 *
 * A semantic statId -> StatKey map is still needed eventually, but only to score
 * *nflverse* stat lines for our own projections. It is not needed for this.
 */

export interface EspnScoringItem {
  readonly statId: number;
  readonly points: number;
  /** Per-position overrides, keyed by player `defaultPositionId` as a string. */
  readonly pointsOverrides?: Record<string, number> | null;
}

export interface EspnScoringRules {
  readonly base: ReadonlyMap<number, number>;
  readonly overrides: ReadonlyMap<number, Readonly<Record<string, number>>>;
  readonly itemCount: number;
}

export function parseEspnScoring(items: readonly EspnScoringItem[]): EspnScoringRules {
  const base = new Map<number, number>();
  const overrides = new Map<number, Record<string, number>>();

  for (const item of items) {
    base.set(item.statId, item.points);
    if (item.pointsOverrides && Object.keys(item.pointsOverrides).length > 0) {
      overrides.set(item.statId, item.pointsOverrides);
    }
  }

  return { base, overrides, itemCount: items.length };
}

export interface ScoredStat {
  readonly statId: number;
  readonly value: number;
  readonly points: number;
}

export interface EspnScore {
  readonly total: number;
  /** Non-zero contributions, for showing why a projection is what it is. */
  readonly parts: readonly ScoredStat[];
}

/**
 * Score a raw ESPN stats map.
 *
 * `positionId` is the player's `defaultPositionId` — the same id space as
 * `pointsOverrides` keys, and deliberately *not* `lineupSlotId`, which collides
 * with it on RB and D/ST.
 */
export function scoreEspnStats(
  stats: Readonly<Record<string, number>>,
  positionId: number | string,
  rules: EspnScoringRules,
): EspnScore {
  const pos = String(positionId);
  const parts: ScoredStat[] = [];
  let total = 0;

  for (const [key, value] of Object.entries(stats)) {
    const statId = Number(key);
    if (!Number.isFinite(statId) || typeof value !== 'number') continue;

    const points = rules.overrides.get(statId)?.[pos] ?? rules.base.get(statId);
    if (!points) continue; // unscored stat, or worth zero in this league

    const contribution = value * points;
    if (contribution !== 0) parts.push({ statId, value, points: contribution });
    total += contribution;
  }

  return { total: Math.round(total * 100) / 100, parts };
}

/** ESPN stat id 53 is receptions, which is what makes a league PPR. */
export function pprLabelFromRules(rules: EspnScoringRules): string {
  const rec = rules.base.get(53) ?? 0;
  if (rec >= 1) return 'Full PPR';
  if (rec > 0) return `${rec} PPR`;
  return 'Standard';
}
