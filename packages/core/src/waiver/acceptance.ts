/**
 * How likely the other manager is to accept a trade.
 *
 * This is a stated rule of thumb, not a fitted model: nobody's accepted and
 * rejected offers are recorded anywhere the app can read, so there is nothing
 * to fit. It rests on two things that do hold in practice:
 *
 *   - a manager accepts when their own starting lineup gains, and the more it
 *     gains the more likely they are to say yes;
 *   - a manager resists sending the better-projected player, however the
 *     lineups work out, because that is the side of the deal they feel.
 *
 * It is reported as a rough band, never a precise figure, and the page says it
 * is a guess.
 */

/** The gain at which a manager is as likely to accept as not, in points. */
const EVEN_GAIN = 1.5;
/** How sharply the chance rises with their gain. */
const SPREAD = 1.2;
/** Most the distaste for sending the better player can cut the chance. */
const NAME_PENALTY = 0.35;

export interface AcceptanceInput {
  /** What their best starting lineup gains from the trade. */
  readonly theirGain: number;
  /** Projections of the player they would receive, and the one they would send. */
  readonly theyReceive: number;
  readonly theySend: number;
}

/** The chance they accept, 0 to 1. */
export function tradeAcceptance({ theirGain, theyReceive, theySend }: AcceptanceInput): number {
  const base = 1 / (1 + Math.exp(-(theirGain - EVEN_GAIN) / SPREAD));
  // Sending the bigger name is the part a manager feels, whatever the lineup says.
  const worse = Math.max(0, theySend - theyReceive) / Math.max(1, theySend);
  const chance = base * (1 - NAME_PENALTY * worse);
  return Math.min(0.9, Math.max(0.05, Math.round(chance * 100) / 100));
}

/** "unlikely", "worth asking", "likely": what the number means, without false precision. */
export function acceptanceLabel(chance: number): string {
  if (chance < 0.25) return 'unlikely';
  if (chance < 0.45) return 'worth asking';
  if (chance < 0.65) return 'even odds';
  return 'likely';
}
