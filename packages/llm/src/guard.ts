/**
 * "No invented numbers."
 *
 * The prompts tell the model to use only the engine's numbers, but a prompt is a
 * request, not a guarantee. This check makes it one: every number in the
 * model's text must appear in the facts it was given, or the text is withheld.
 * A plausible-looking projection the engine never produced is exactly the
 * failure the previous version shipped, when fabricated rosters reached real
 * decisions.
 */

/** Small counts ("two changes", "3 QBs", "a 2-for-1") are prose, not claims about value. */
const ALWAYS_ALLOWED_MAX = 5;

/** The facts round to one decimal, so allow for the model re-rounding 104.36 as 104.4. */
const TOLERANCE = 0.051;

/**
 * Every number in a piece of text, unsigned.
 *
 * Signs are dropped on purpose: the facts may say a margin is "-4.1" and the
 * model may correctly write "behind by 4.1".
 */
export function extractNumbers(text: string): number[] {
  return [...text.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
}

export interface GuardResult {
  readonly ok: boolean;
  /** Numbers in the text that the facts do not contain. */
  readonly invented: readonly number[];
}

export function checkNumbers(text: string, facts: string): GuardResult {
  const allowed = extractNumbers(facts);
  const invented = [...new Set(extractNumbers(text))].filter((n) => {
    if (Number.isInteger(n) && n <= ALWAYS_ALLOWED_MAX) return false;
    return !allowed.some((a) => Math.abs(a - n) < TOLERANCE);
  });
  return { ok: invented.length === 0, invented };
}

/**
 * Which of these players a piece of text names, by full name or surname.
 *
 * Used on trade pitches, where the model is told not to name the players at
 * all: if it does, it may be restating — or reversing — terms the app has
 * already stated exactly.
 */
export function namesIn(text: string, names: readonly string[]): string[] {
  const t = text.toLowerCase();
  return names.filter((full) => {
    const name = full.toLowerCase().trim();
    if (t.includes(name)) return true;
    const surname = name.replace(/\s+(jr|sr|ii|iii|iv|v)\.?$/, '').split(/\s+/).pop() ?? '';
    return surname.length > 3 && new RegExp(`\\b${escapeRegExp(surname)}\\b`).test(t);
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether the model's reason for a trade offer may be shown.
 *
 * It may mention the player the recipient would receive — in live testing it
 * almost always did, and always correctly ("adding Trevor Lawrence…"). It may
 * not mention the player they would give up: every reversed draft seen named
 * that player as the one they would get. Numbers must come from the facts, as
 * everywhere else.
 */
export function pitchReasonOk(reason: string, facts: string, givesUp: string): boolean {
  return (
    reason.trim().length > 0 &&
    checkNumbers(reason, facts).ok &&
    namesIn(reason, [givesUp]).length === 0
  );
}
