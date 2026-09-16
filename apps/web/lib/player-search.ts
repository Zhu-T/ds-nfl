/**
 * Search over the players a page has already loaded. No request is made.
 *
 * Every word typed must start a word of what is searched, so "st brown" and
 * "jamarr" work while "rb" does not match inside a surname. Names come first:
 * when any player's name matches, only those players are shown. Otherwise
 * position, NFL team, and owner are searched too, so "wr det", "waivers", or a
 * fantasy team's name still find players. A position code typed on its own
 * word ("wr", "te", "k", "dst" or "def") picks that position rather than names
 * that start with it, so "wr" lists receivers, not the Wrights.
 */

/** Lowercase, accents and apostrophes dropped, other punctuation a space: "Ja'Marr" is "jamarr", "Amon-Ra" is "amon ra". */
export function searchWords(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’.]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export interface Searchable {
  readonly name: string;
  readonly position: string;
  readonly proTeam: string | null;
  readonly owner: string;
}

const covers = (words: readonly string[], wanted: readonly string[]) =>
  wanted.every((w) => words.some((word) => word.startsWith(w)));

const POSITION_WORDS: Record<string, string> = { qb: 'QB', rb: 'RB', wr: 'WR', te: 'TE', k: 'K', dst: 'DST', def: 'DST' };

/** The rows a query finds, in their original order. */
export function searchPlayers<T extends Searchable>(rows: readonly T[], query: string): T[] {
  const words = searchWords(query);
  const positions = new Set(words.flatMap((w) => (POSITION_WORDS[w] ? [POSITION_WORDS[w]] : [])));
  const wanted = words.filter((w) => !POSITION_WORDS[w]);
  const pool = positions.size > 0 ? rows.filter((r) => positions.has(r.position.replace('/', '').toUpperCase())) : [...rows];
  if (wanted.length === 0) return pool;
  const byName = pool.filter((r) => covers(searchWords(r.name), wanted));
  if (byName.length > 0) return byName;
  return pool.filter((r) => covers(searchWords(`${r.name} ${r.proTeam ?? ''} ${r.owner}`), wanted));
}
