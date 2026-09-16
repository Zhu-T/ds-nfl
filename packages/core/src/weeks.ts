/**
 * Which scoring week to plan.
 *
 * While a week is being played, next week's lineup, waiver pickups, and trades
 * are already worth deciding: pickups made now play next week, and the lineup
 * for next week can be set before anything locks.
 */

export type WeekChoice = 'this' | 'next';

/** The week to show for a choice. There is no "next" after the season's final week. */
export function planningWeek(choice: WeekChoice, currentWeek: number, finalWeek: number): number {
  return choice === 'next' && currentWeek < finalWeek ? currentWeek + 1 : currentWeek;
}

/**
 * A week named by a request, kept within the season and never before the week
 * being played: a page rendered for week 2 on Sunday is still about week 2 on
 * Tuesday, but a page rendered for week 1 is not a way to write to a week that
 * has finished.
 */
export function clampWeek(requested: number, currentWeek: number, finalWeek: number): number {
  if (!Number.isFinite(requested)) return currentWeek;
  return Math.min(finalWeek, Math.max(currentWeek, Math.trunc(requested)));
}
