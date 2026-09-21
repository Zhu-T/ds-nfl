/**
 * Looking players up for one chat question.
 *
 * The brief carries only a short summary of who is available. For each
 * question the app finds, in the league's saved player list, the players it
 * names, the fantasy teams it names, and the positions it asks about, and
 * attaches just those rows. The model never searches: the app decides what it
 * sees, and the number guard checks the answer against exactly that.
 */

const n = (x: number): string => x.toFixed(1);

export interface LookupPlayer {
  readonly name: string;
  readonly position: string;
  readonly proTeam: string | null;
  /** "Your roster", another team's name, "Waivers", or "Free agent". */
  readonly owner: string;
  readonly ownerKind: 'mine' | 'team' | 'waivers' | 'free-agent';
  readonly projected: number;
  /** For unrostered players: points added to your best possible lineup. */
  readonly gain?: number;
  readonly note?: string;
}

/** Most rows one question attaches. */
export const LOOKUP_LIMIT = 30;
/** Unrostered players listed for each position a question asks about. */
const PER_POSITION = 10;

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);
/** Kept with the surname: "St. Brown", "Van Ginkel". */
const PARTICLES = new Set(['st', 'van', 'von', 'de', 'la', 'le', 'du', 'da', 'di']);
/**
 * Names that are also everyday words. As a surname they count only when
 * capitalized in the question ("Love", not "love"); as a first name, never.
 */
const EVERYDAY = new Set([
  'love', 'chase', 'price', 'hill', 'rice', 'moore', 'young', 'white', 'brown', 'green', 'hunt', 'wright',
  'bell', 'cook', 'hurts', 'hall', 'long', 'ward', 'king', 'lane', 'ford', 'best', 'little', 'mills', 'banks',
  'will', 'hunter', 'grant', 'drake', 'rich', 'mason', 'ray', 'rashee',
]);
/** Words a fantasy team's name shares with too many sentences to identify it. */
const GENERIC = new Set(['team', 'the', 'fantasy', 'league', 'football', 'club', 'squad', 'champs', 'dynasty']);
const POSITION_WORDS: Readonly<Record<string, readonly string[]>> = {
  qb: ['QB'], qbs: ['QB'], quarterback: ['QB'], quarterbacks: ['QB'],
  rb: ['RB'], rbs: ['RB'],
  wr: ['WR'], wrs: ['WR'], receiver: ['WR'], receivers: ['WR'], wideout: ['WR'], wideouts: ['WR'],
  te: ['TE'], tes: ['TE'],
  k: ['K'], kicker: ['K'], kickers: ['K'],
  dst: ['DST'], def: ['DST'], defense: ['DST'], defenses: ['DST'], defence: ['DST'],
  flex: ['RB', 'WR', 'TE'],
};
const POSITION_PHRASES: Readonly<Record<string, string>> = {
  'running back': 'RB', 'running backs': 'RB', 'tight end': 'TE', 'tight ends': 'TE', 'd st': 'DST',
};
/** A question about these wants the unrostered players, even when it names a team. */
const AVAILABILITY = new Set(['available', 'waiver', 'waivers', 'wire', 'free', 'pickup', 'pickups', 'pick', 'add', 'claim', 'stream', 'streaming']);

/** Lowercase words, accents and possessives dropped: "Miguel's" is "miguel", "Ja'Marr" is "jamarr". */
function words(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/['’.]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

interface NameKeys {
  readonly full: string;
  readonly surname: string;
  readonly first: string;
}

function nameKeys(p: LookupPlayer): NameKeys {
  const w = words(p.name).filter((x) => !SUFFIXES.has(x));
  // "Panthers D/ST" is asked about as "the Panthers".
  if (p.position === 'DST') return { full: w.join(' '), surname: w[0] ?? '', first: '' };
  const surname = w.length >= 3 && PARTICLES.has(w[w.length - 2]!) ? w.slice(-2).join(' ') : (w[w.length - 1] ?? '');
  return { full: w.join(' '), surname, first: w.length > 1 ? w[0]! : '' };
}

/** "Love" written with a capital, as a name is. */
function capitalized(question: string, word: string): boolean {
  const cap = word[0]!.toUpperCase() + word.slice(1);
  return new RegExp(`(^|[^A-Za-z])${cap}(?![A-Za-z])`).test(question);
}

const byProjection = (a: LookupPlayer, b: LookupPlayer) => b.projected - a.projected;

/**
 * The rows of `list` a question is about, most relevant first: players it
 * names, then the rosters of fantasy teams it names, then the best unrostered
 * players at positions it asks about. Your own roster is left out; the brief
 * already has it.
 */
export function lookUpPlayers<T extends LookupPlayer>(
  question: string,
  list: readonly T[],
  /**
   * `includeMine` also finds your own players by name (the brief already lists
   * them, so chat lookups leave them out); `namesOnly` skips team rosters and
   * position lists. Both are for working out a named move.
   */
  options: { readonly includeMine?: boolean; readonly namesOnly?: boolean } = {},
): T[] {
  const text = ` ${words(question).join(' ')} `;
  const has = (phrase: string) => phrase !== '' && text.includes(` ${phrase} `);
  const others = list.filter((p) => p.ownerKind !== 'mine');
  const nameable = options.includeMine ? list : others;
  const found: T[] = [];
  const add = (p: T) => {
    if (found.length < LOOKUP_LIMIT && !found.includes(p)) found.push(p);
  };

  // Players named: first by full name or a two-word surname ("St. Brown"), and
  // then, in what is left of the question, by surname or a first name only one
  // of them has. So "Amon-Ra St. Brown" does not also find every other Brown.
  const keys = new Map(nameable.map((p) => [p, nameKeys(p)]));
  const strong = new Set(nameable.filter((p) => {
    const k = keys.get(p)!;
    return has(k.full) || (k.surname.includes(' ') && has(k.surname));
  }));
  let rest = text;
  for (const p of strong) {
    const k = keys.get(p)!;
    for (const phrase of [k.full, k.surname]) if (phrase.includes(' ')) rest = rest.split(` ${phrase} `).join(' ');
  }
  const inRest = (phrase: string) => phrase !== '' && rest.includes(` ${phrase} `);
  const firstCount = new Map<string, number>();
  for (const k of keys.values()) if (k.first) firstCount.set(k.first, (firstCount.get(k.first) ?? 0) + 1);
  const usedWords = new Set<string>();
  for (const [p, k] of keys) {
    const bySurname =
      k.surname.length >= 3 && inRest(k.surname) && (!EVERYDAY.has(k.surname) || capitalized(question, k.surname));
    const byFirst = k.first.length >= 4 && !EVERYDAY.has(k.first) && firstCount.get(k.first) === 1 && inRest(k.first);
    if (strong.has(p) || bySurname || byFirst) add(p);
    if (bySurname) usedWords.add(k.surname);
    if (byFirst) usedWords.add(k.first);
  }
  // What no player's name used, for spotting fantasy team names.
  let leftover = rest;
  for (const w of usedWords) leftover = leftover.split(` ${w} `).join(' ');
  const inLeftover = (word: string) => leftover.includes(` ${word} `);

  if (options.namesOnly) return found;

  // Positions asked about.
  const asked = new Set<string>();
  for (const w of text.trim().split(' ')) for (const pos of POSITION_WORDS[w] ?? []) asked.add(pos);
  for (const [phrase, pos] of Object.entries(POSITION_PHRASES)) if (has(phrase)) asked.add(pos);
  const atAsked = (p: T) => asked.size === 0 || asked.has(p.position);

  // Fantasy teams named, by full name or by a word no other team's name has
  // and no player's name in the question used.
  const teams = [...new Set(others.filter((p) => p.ownerKind === 'team').map((p) => p.owner))];
  const teamWords = new Map(teams.map((t) => [t, words(t)]));
  const wordCount = new Map<string, number>();
  for (const ws of teamWords.values()) for (const w of new Set(ws)) wordCount.set(w, (wordCount.get(w) ?? 0) + 1);
  const named = teams.filter((t) => {
    const ws = teamWords.get(t)!;
    return has(ws.join(' ')) || ws.some((w) => w.length >= 5 && !GENERIC.has(w) && wordCount.get(w) === 1 && inLeftover(w));
  });
  for (const team of named) {
    others.filter((p) => p.owner === team && atAsked(p)).sort(byProjection).forEach(add);
  }

  // The best unrostered players at the positions asked about.
  const wantsAvailable = named.length === 0 || text.trim().split(' ').some((w) => AVAILABILITY.has(w));
  if (asked.size > 0 && wantsAvailable) {
    for (const pos of asked) {
      others
        .filter((p) => (p.ownerKind === 'waivers' || p.ownerKind === 'free-agent') && p.position === pos)
        .sort(byProjection)
        .slice(0, PER_POSITION)
        .forEach(add);
    }
  }
  return found;
}

/**
 * The looked-up rows as the model reads them, grouped under who has the
 * players; empty when nothing was looked up. The headings are there because a
 * small local model otherwise mixes the rows up with the roster in the brief.
 */
export function lookupBlock(players: readonly LookupPlayer[], updated: string): string {
  if (players.length === 0) return '';
  const groups = new Map<string, LookupPlayer[]>();
  for (const p of players) {
    const heading =
      p.ownerKind === 'team'
        ? `Rostered by ${p.owner}:`
        : p.ownerKind === 'mine'
          ? 'On your roster:'
          : 'Not on any roster in the league:';
    groups.set(heading, [...(groups.get(heading) ?? []), p]);
  }
  return [
    `Players the app looked up for this question, from the league's player list (updated ${updated}). Answer from these rows; for these players they are more complete than the context. Unrostered players' projections include web news and betting lines, as on the Waivers page; other teams' players show ESPN's projection.`,
    ...[...groups].flatMap(([heading, rows]) => ['', heading, ...rows.map(lookupRow)]),
  ].join('\n');
}

function lookupRow(p: LookupPlayer): string {
  const team = p.proTeam ? `, ${p.proTeam}` : '';
  const where =
    p.ownerKind === 'team'
      ? `rostered by ${p.owner}`
      : p.ownerKind === 'mine'
        ? 'on your roster'
        : p.ownerKind === 'waivers'
          ? 'on waivers, needs a claim'
          : 'free agent, can be added now';
  const gain = p.gain !== undefined ? `, adds ${n(p.gain)} to your best lineup` : '';
  const note = p.note ? `; ${p.note}` : '';
  return `- ${p.name} (${p.position}${team}): ${where}; projected ${n(p.projected)}${gain}${note}`;
}

/** The question as sent: the looked-up rows first, when there are any. */
export function withLookup(question: string, block: string): string {
  return block ? `${block}\n\nQuestion: ${question}` : question;
}
