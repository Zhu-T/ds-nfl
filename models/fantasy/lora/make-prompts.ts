/**
 * Training prompts for the LoRA fine-tune: varied facts built by the app's own
 * fact builders, wrapped in the app's own prompts.
 *
 *   npx vite-node models/fantasy/lora/make-prompts.ts
 *
 * Deterministic (seeded). Players and team names are drawn from a pool the eval
 * fixtures do not use, so the eval stays a held-out test. Writes
 * data/prompts.jsonl, plus data/sheets/*.md: the same prompts, readable, for
 * whoever writes the target answers.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  explainLineupRequest,
  leagueChatRequest,
  leagueContext,
  lineupFacts,
  pitchTradeRequest,
  tradeFacts,
  type ContextNews,
  type ContextRosterPlayer,
  type ContextTrade,
  type ContextWaiver,
  type LineupFactsInput,
  type LineupMoveFact,
  type LlmRequest,
  type TradeFactsInput,
} from '../../../packages/llm/src/index.js';

// ---------------------------------------------------------------- random

let seed = 20260914;
/** mulberry32 */
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const chance = (p: number): boolean => rand() < p;
/** A projection in tenths, so sums and differences stay exact at one decimal. */
const proj = (lo: number, hi: number): number => int(lo * 10, hi * 10) / 10;
const r1 = (x: number): number => Math.round(x * 10) / 10;

// ---------------------------------------------------------------- pool

type Pos = 'QB' | 'RB' | 'WR' | 'TE' | 'K' | 'DST';

interface Player {
  readonly name: string;
  readonly pos: Pos;
  readonly team: string;
}

// No names with initials or Jr./Sr.: their periods make sentence counts unreliable.
const POOL: Record<Pos, readonly (readonly [string, string])[]> = {
  QB: [
    ['Josh Allen', 'BUF'], ['Lamar Jackson', 'BAL'], ['Patrick Mahomes', 'KC'], ['Joe Burrow', 'CIN'],
    ['Jayden Daniels', 'WSH'], ['Baker Mayfield', 'TB'], ['Kyler Murray', 'ARI'], ['Jordan Love', 'GB'],
    ['Dak Prescott', 'DAL'], ['Brock Purdy', 'SF'], ['Justin Herbert', 'LAC'], ['Bo Nix', 'DEN'],
    ['Caleb Williams', 'CHI'], ['Drake Maye', 'NE'], ['Jared Goff', 'DET'], ['Matthew Stafford', 'LAR'],
  ],
  RB: [
    ['Saquon Barkley', 'PHI'], ['Jahmyr Gibbs', 'DET'], ['Derrick Henry', 'BAL'], ['Josh Jacobs', 'GB'],
    ["De'Von Achane", 'MIA'], ['Jonathan Taylor', 'IND'], ['Breece Hall', 'NYJ'], ['Chase Brown', 'CIN'],
    ['Alvin Kamara', 'NO'], ['Chuba Hubbard', 'CAR'], ['Aaron Jones', 'MIN'], ['James Conner', 'ARI'],
    ['Tony Pollard', 'TEN'], ['David Montgomery', 'DET'], ['Joe Mixon', 'HOU'], ['Isiah Pacheco', 'KC'],
    ['Travis Etienne', 'JAX'], ['Ashton Jeanty', 'LV'], ['Omarion Hampton', 'LAC'], ['TreVeyon Henderson', 'NE'],
    ['Javonte Williams', 'DAL'], ['Zach Charbonnet', 'SEA'], ['Tank Bigsby', 'JAX'], ['Rachaad White', 'TB'],
    ['Tyjae Spears', 'TEN'], ['Kenneth Walker', 'SEA'],
  ],
  WR: [
    ["Ja'Marr Chase", 'CIN'], ['Justin Jefferson', 'MIN'], ['CeeDee Lamb', 'DAL'], ['Puka Nacua', 'LAR'],
    ['Malik Nabers', 'NYG'], ['Nico Collins', 'HOU'], ['Drake London', 'ATL'], ['Ladd McConkey', 'LAC'],
    ['Tyreek Hill', 'MIA'], ['Mike Evans', 'TB'], ['Davante Adams', 'LAR'], ['Terry McLaurin', 'WSH'],
    ['Jaxon Smith-Njigba', 'SEA'], ['DJ Moore', 'CHI'], ['Zay Flowers', 'BAL'], ['Courtland Sutton', 'DEN'],
    ['George Pickens', 'DAL'], ['Jameson Williams', 'DET'], ['Xavier Worthy', 'KC'], ['Jerry Jeudy', 'CLE'],
    ['Calvin Ridley', 'TEN'], ['Jordan Addison', 'MIN'], ['Rome Odunze', 'CHI'], ['Keon Coleman', 'BUF'],
    ['Khalil Shakir', 'BUF'], ['Josh Downs', 'IND'], ['Cooper Kupp', 'SEA'], ['Stefon Diggs', 'NE'],
    ['Jauan Jennings', 'SF'], ['Darnell Mooney', 'ATL'], ['Ricky Pearsall', 'SF'], ['Travis Hunter', 'JAX'],
    ['Tetairoa McMillan', 'CAR'], ['Emeka Egbuka', 'TB'], ['Marvin Mims', 'DEN'],
  ],
  TE: [
    ['Brock Bowers', 'LV'], ['George Kittle', 'SF'], ['Sam LaPorta', 'DET'], ['Travis Kelce', 'KC'],
    ['Mark Andrews', 'BAL'], ['David Njoku', 'CLE'], ['Tucker Kraft', 'GB'], ['Jake Ferguson', 'DAL'],
    ['Kyle Pitts', 'ATL'], ['Evan Engram', 'DEN'], ['Dallas Goedert', 'PHI'], ['Hunter Henry', 'NE'],
    ['Tyler Warren', 'IND'], ['Colston Loveland', 'CHI'], ['Isaiah Likely', 'BAL'], ['Cade Otton', 'TB'],
  ],
  K: [
    ['Brandon Aubrey', 'DAL'], ['Cameron Dicker', 'LAC'], ["Ka'imi Fairbairn", 'HOU'], ['Chris Boswell', 'PIT'],
    ['Harrison Butker', 'KC'], ['Tyler Bass', 'BUF'], ['Jason Myers', 'SEA'], ['Wil Lutz', 'DEN'],
    ['Chase McLaughlin', 'TB'], ['Evan McPherson', 'CIN'],
  ],
  DST: [
    ['Ravens D/ST', 'BAL'], ['Bills D/ST', 'BUF'], ['Broncos D/ST', 'DEN'], ['Eagles D/ST', 'PHI'],
    ['Vikings D/ST', 'MIN'], ['Texans D/ST', 'HOU'], ['Chiefs D/ST', 'KC'], ['Lions D/ST', 'DET'],
    ['Packers D/ST', 'GB'], ['Seahawks D/ST', 'SEA'], ['Chargers D/ST', 'LAC'], ['Cowboys D/ST', 'DAL'],
  ],
};

const RANGE: Record<Pos, readonly [number, number]> = {
  QB: [10, 27], RB: [3, 22], WR: [3, 21], TE: [2, 15], K: [4, 11], DST: [2, 11],
};

const TEAMS = [
  'Waiver Wire Warriors', 'Bye Week Blues', 'Monday Night Miracle', 'Fourth and Long', 'Taco Corp',
  'The Commish', 'Red Zone Regulars', 'Gridiron Gang', 'Fantasy Island', 'The Blitz', 'Hail Mary Heroes',
  'End Zone Express', 'Punt Squad', 'Dynasty Dreamers', 'Couch Coaches', 'Two Point Conversion',
  'Sack Masters', 'Big Play Bandits', 'Kickoff Kings', 'Screen Pass Society',
];
const LEAGUES = [
  'Office League', 'Family League', 'College Friends', 'Neighborhood League', 'Dynasty League',
  'Draft Night League', 'Brothers League', 'Alumni League',
];
const FORMATS = ['PPR', 'Half PPR', 'Standard'];
const INJURIES = ['ankle', 'hamstring', 'knee', 'shoulder', 'groin', 'calf', 'back', 'concussion'];

/** Draws players without repeats within one example. */
function drawer() {
  const used = new Set<string>();
  return (pos: Pos): Player => {
    for (;;) {
      const [name, team] = pick(POOL[pos]);
      if (!used.has(name)) {
        used.add(name);
        return { name, pos, team };
      }
    }
  };
}

// ---------------------------------------------------------------- rosters

type Injury = 'Questionable' | 'Doubtful' | 'Out';

interface Spot {
  player: Player | null;
  slot: string;
  projected: number;
  injury?: Injury;
  locked: boolean;
}

function eligible(slot: string, pos: Pos): boolean {
  if (slot === 'FLEX') return pos === 'RB' || pos === 'WR' || pos === 'TE';
  if (slot === 'OP') return pos !== 'K' && pos !== 'DST';
  return slot === pos;
}

interface Week {
  readonly league: string;
  readonly format: string;
  readonly week: number;
  readonly team: string;
  readonly opponent: string;
  readonly planningAhead: boolean;
  readonly spots: Spot[];
  readonly draw: (pos: Pos) => Player;
}

function makeWeek(): Week {
  const draw = drawer();
  const planningAhead = chance(0.25);
  const slots = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', ...(chance(0.2) ? ['OP'] : []), 'K', 'DST'];
  const make = (slot: string, pos: Pos): Spot => {
    const player = draw(pos);
    // Bench players come from the lower part of the range, as on a real roster,
    // or nearly every example would be a lineup the manager set badly.
    const [lo, hi] = RANGE[pos];
    const projected = slot === 'BENCH' ? proj(lo, lo + (hi - lo) * 0.7) : proj(lo, hi);
    const spot: Spot = { player, slot, projected, locked: false };
    if (pos !== 'DST' && chance(0.12)) {
      spot.injury = pick<Injury>(['Questionable', 'Questionable', 'Questionable', 'Doubtful', 'Out']);
      if (spot.injury === 'Out') spot.projected = 0;
      if (spot.injury === 'Doubtful') spot.projected = r1(spot.projected * 0.4);
    }
    return spot;
  };
  const spots: Spot[] = slots.map((slot) =>
    make(slot, slot === 'FLEX' ? pick<Pos>(['RB', 'WR', 'WR', 'TE']) : slot === 'OP' ? pick<Pos>(['QB', 'RB', 'WR']) : (slot as Pos)),
  );
  const benchPositions: Pos[] = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', ...(slots.includes('OP') ? (['QB'] as Pos[]) : [])];
  for (const pos of benchPositions) spots.push(make('BENCH', pos));

  // Most managers set most of their lineup well: about 30% of weeks need no
  // changes, about 45% need one or two, and the rest need three or more.
  const setting = rand();
  if (setting < 0.7) {
    const skip = setting < 0.2 ? 0 : 0.35;
    for (const slot of SLOT_ORDER) {
      if (chance(skip)) continue;
      for (const starter of spots.filter((s) => s.slot === slot)) {
        const best = spots
          .filter((b) => b.slot === 'BENCH' && eligible(slot, b.player!.pos) && b.projected > starter.projected)
          .sort((a, b) => b.projected - a.projected)[0];
        if (best) {
          best.slot = slot;
          starter.slot = 'BENCH';
        }
      }
    }
  }

  // Now and then a starter slot is empty because its player went to IR.
  if (chance(0.08)) {
    const empty = pick(spots.filter((s) => ['RB', 'WR', 'TE', 'FLEX'].includes(s.slot)));
    spots.push({ player: empty.player, slot: 'IR', projected: 0, injury: 'Out', locked: false });
    empty.player = null;
    empty.projected = 0;
    delete empty.injury;
  }

  // Some games have kicked off.
  if (!planningAhead && chance(0.35)) {
    const n = int(1, 4);
    for (const s of spots.filter((x) => x.player && x.slot !== 'IR').sort(() => rand() - 0.5).slice(0, n)) s.locked = true;
  }

  const team = pick(TEAMS);
  let opponent = pick(TEAMS);
  while (opponent === team) opponent = pick(TEAMS);
  return { league: pick(LEAGUES), format: pick(FORMATS), week: int(1, 17), team, opponent, planningAhead, spots, draw };
}

const SLOT_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DST', 'FLEX', 'OP'];

/** A simple optimizer: fill each slot with the best eligible bench player who beats its starter. */
function optimize(week: Week): { moves: LineupMoveFact[]; current: number; optimized: number; starters: Spot[] } {
  const starters = week.spots.filter((s) => SLOT_ORDER.includes(s.slot)).map((s) => ({ ...s }));
  const bench = week.spots.filter((s) => s.slot === 'BENCH' && !s.locked && s.player).map((s) => ({ ...s }));
  const current = r1(starters.reduce((sum, s) => sum + s.projected, 0));
  const moves: LineupMoveFact[] = [];
  for (const slot of SLOT_ORDER) {
    for (const starter of starters.filter((s) => s.slot === slot)) {
      if (starter.locked) continue;
      const best = bench
        .filter((b) => eligible(slot, b.player!.pos) && b.projected > starter.projected)
        .sort((a, b) => b.projected - a.projected)[0];
      if (!best) continue;
      moves.push({
        slot,
        outName: starter.player?.name ?? null,
        outProjected: starter.player ? starter.projected : null,
        ...(starter.player && starter.injury && starter.injury !== 'Questionable' ? { outNote: starter.injury } : {}),
        inName: best.player!.name,
        inPosition: best.player!.pos,
        inProjected: best.projected,
      });
      bench.splice(bench.indexOf(best), 1);
      if (starter.player) bench.push({ ...starter, slot: 'BENCH' });
      Object.assign(starter, { player: best.player, projected: best.projected, injury: best.injury, locked: false });
    }
  }
  const optimized = r1(starters.reduce((sum, s) => sum + s.projected, 0));
  return { moves, current, optimized, starters };
}

function lineupInput(week: Week): { input: LineupFactsInput; starters: Spot[]; optimized: number } {
  const newsAdjusted: { name: string; status: string; from: number; to: number }[] = [];
  const questionable = week.spots.find((s) => s.injury === 'Questionable' && s.player && SLOT_ORDER.includes(s.slot));
  if (questionable && chance(0.3)) {
    const from = questionable.projected;
    questionable.projected = r1(from * pick([0.5, 0.75, 0.9]));
    newsAdjusted.push({ name: questionable.player!.name, status: 'questionable', from, to: questionable.projected });
  }
  const { moves, current, optimized, starters } = optimize(week);
  const opponentProjected = r1(optimized + proj(-18, 18));
  const input: LineupFactsInput = {
    leagueName: week.league,
    format: week.format,
    week: week.week,
    currentPoints: current,
    optimizedPoints: optimized,
    pointsGained: r1(optimized - current),
    moves,
    lockedPlayers: week.spots.filter((s) => s.locked).map((s) => s.player!.name),
    ...(week.planningAhead ? { planningAhead: true } : {}),
    ...(newsAdjusted.length > 0 ? { newsAdjusted } : {}),
    flagged: starters
      .filter((s) => s.player && (s.injury === 'Questionable' || s.injury === 'Doubtful'))
      .map((s) => ({ name: s.player!.name, note: s.injury! })),
    matchup: chance(0.88)
      ? {
          opponent: week.opponent,
          opponentProjected,
          ...(week.planningAhead && chance(0.7) ? { opponentBest: true } : {}),
          marginNow: r1(current - opponentProjected),
          marginAfter: r1(optimized - opponentProjected),
        }
      : null,
  };
  return { input, starters, optimized };
}

// ---------------------------------------------------------------- examples

interface Prompt {
  readonly id: string;
  readonly task: 'lineup' | 'pitch' | 'chat';
  readonly request: LlmRequest;
  /** What the number guard checks an answer against, as in the app. */
  readonly facts: string;
  readonly givesUp?: string;
  readonly question?: string;
  /** Chat only: the brief cannot answer the question, and the answer must say so. */
  readonly unanswerable?: boolean;
}

function lineupPrompt(id: string): Prompt {
  const { input } = lineupInput(makeWeek());
  const facts = lineupFacts(input);
  return { id, task: 'lineup', request: explainLineupRequest(facts), facts };
}

function pitchPrompt(id: string): Prompt {
  const draw = drawer();
  const myTeam = pick(TEAMS);
  let opponentTeam = pick(TEAMS);
  while (opponentTeam === myTeam) opponentTeam = pick(TEAMS);
  const givePos = pick<Pos>(['QB', 'RB', 'RB', 'WR', 'WR', 'TE']);
  const getPos = pick<Pos>(['QB', 'RB', 'WR', 'WR', 'TE']);
  const input: TradeFactsInput = {
    week: int(1, 16),
    myTeam,
    opponentTeam,
    give: draw(givePos).name,
    giveProjected: proj(...RANGE[givePos]),
    get: draw(getPos).name,
    getProjected: proj(...RANGE[getPos]),
    theirGain: proj(0.1, 7.5),
  };
  const facts = tradeFacts(input);
  return { id, task: 'pitch', request: pitchTradeRequest(facts), facts, givesUp: input.get };
}

interface Brief {
  readonly week: Week;
  readonly text: string;
  readonly moves: readonly LineupMoveFact[];
  readonly waivers: readonly ContextWaiver[];
  readonly trades: readonly ContextTrade[];
  readonly hasMatchup: boolean;
}

function makeBrief(): Brief {
  const week = makeWeek();
  const { input, starters } = lineupInput(week);
  const roster: ContextRosterPlayer[] = week.spots
    .filter((s) => s.player)
    .map((s) => {
      const note = [s.injury, s.locked ? 'locked' : undefined].filter(Boolean).join(', ');
      return {
        name: s.player!.name,
        position: s.player!.pos,
        slot: s.slot,
        projected: s.projected,
        proTeam: s.player!.team,
        ...(note ? { note } : {}),
      };
    });

  const waivers: ContextWaiver[] = [];
  for (let i = int(0, 6); i > 0; i--) {
    const pos = pick<Pos>(['RB', 'WR', 'WR', 'TE', 'QB', 'K', 'DST']);
    const player = week.draw(pos);
    const projected = proj(...RANGE[pos]);
    const weakest = starters
      .filter((s) => eligible(s.slot, pos) && !s.locked)
      .reduce((m, s) => Math.min(m, s.projected), Infinity);
    const gain = r1(projected - weakest);
    if (Number.isFinite(gain) && gain > 0) {
      waivers.push({ name: player.name, position: pos, projected, gain, pickup: chance(0.5) ? 'free-agent' : 'waivers' });
    }
  }
  waivers.sort((a, b) => b.gain - a.gain);

  const trades: ContextTrade[] = [];
  const mine = week.spots.filter((s) => s.player && s.slot !== 'IR' && s.player.pos !== 'K' && s.player.pos !== 'DST');
  for (let i = int(0, 3); i > 0; i--) {
    trades.push({
      give: pick(mine).player!.name,
      get: week.draw(pick<Pos>(['RB', 'WR', 'TE', 'QB'])).name,
      opponent: pick(TEAMS.filter((t) => t !== week.team)),
      myGain: proj(0.2, 6),
      theirGain: proj(0.2, 6),
    });
  }

  const day = int(8, 27);
  const month = pick(['09', '10', '11']);
  const date = (back: number): string => `2026-${month}-${String(day - back).padStart(2, '0')}`;
  const surname = (name: string): string => name.split(' ').slice(1).join(' ') || name;
  const news: ContextNews[] = [];
  for (const s of week.spots.filter((x) => x.player && x.injury)) {
    const n = s.player!.name;
    const injury = pick(INJURIES);
    news.push(
      s.injury === 'Out'
        ? { player: n, published: date(int(0, 2)), headline: `${surname(n)} ruled out`, story: `${n} will not play this week because of a ${injury} injury.` }
        : s.injury === 'Doubtful'
          ? { player: n, published: date(int(0, 2)), headline: `${surname(n)} unlikely to play`, story: `${n} did not practice all week with a ${injury} injury.` }
          : { player: n, published: date(int(0, 3)), headline: `${surname(n)} limited in practice`, story: `${n} was limited in practice with a ${injury} injury and is listed as questionable.` },
    );
  }
  for (let i = int(0, 2); i > 0; i--) {
    const s = pick(week.spots.filter((x) => x.player && !x.injury));
    const n = s.player!.name;
    news.push(
      pick([
        { player: n, published: date(int(0, 6)), headline: `${surname(n)} expected to see more work`, story: `The coaching staff said ${n} will have a bigger role this week.` },
        { player: n, published: date(int(0, 6)), headline: `${surname(n)} a full participant in practice`, story: '' },
        { player: n, published: date(int(0, 6)), headline: `${surname(n)} sharing the workload`, story: `${n} split snaps evenly last week, and the team expects that to continue.` },
      ]),
    );
  }
  news.sort((a, b) => b.published.localeCompare(a.published));

  const text = leagueContext({
    teamName: week.team,
    ...(week.planningAhead ? { weekLabel: `Week ${week.week} (next week, not started)` } : { weekLabel: `Week ${week.week}` }),
    lineupFacts: lineupFacts(input),
    roster,
    waivers,
    trades,
    news,
  }).text;
  return { week, text, moves: input.moves, waivers, trades, hasMatchup: input.matchup !== null };
}

interface QuestionTemplate {
  readonly ask: (b: Brief, outsider: string) => string | null;
  readonly unanswerable?: boolean;
}

const named = (b: Brief) => b.week.spots.filter((s) => s.player && s.player.pos !== 'DST').map((s) => s.player!.name);

const QUESTIONS: QuestionTemplate[] = [
  { ask: () => 'Who should I start this week?' },
  { ask: () => 'Is anyone on waivers worth picking up?' },
  { ask: (b) => (b.moves[0] ? `Why start ${b.moves[0].inName}?` : null) },
  { ask: (b) => (b.hasMatchup ? `Am I going to beat ${b.week.opponent}?` : null) },
  { ask: () => 'What trade should I make?' },
  { ask: (b) => {
      const s = b.week.spots.find((x) => x.injury && x.player);
      return s ? `Is ${s.player!.name} going to play?` : null;
    } },
  { ask: (b) => {
      const s = b.week.spots.find((x) => x.slot === 'BENCH' && x.player);
      return s ? `Why is ${s.player!.name} on my bench?` : null;
    } },
  { ask: (b) => (b.waivers[0] ? `Should I pick up ${b.waivers[0].name}?` : null) },
  { ask: () => 'Which of my starters is the weakest?' },
  { ask: () => 'Can you set my lineup for me?' },
  { ask: () => 'Any news I should know about?' },
  { ask: () => 'Give me a quick summary of my week.' },
  { ask: (b) => `What slot is ${pick(named(b))} in right now?` },
  { ask: (b) => `How many points did ${pick(named(b))} score last week?`, unanswerable: true },
  { ask: (b) => `What will ${pick(named(b))} project for next week?`, unanswerable: true },
  { ask: (_b, outsider) => `Should I trade for ${outsider}?`, unanswerable: true },
  { ask: () => 'Who is on a bye this week?', unanswerable: true },
  { ask: (b) => `How many rushing yards does ${pick(named(b))} usually get?`, unanswerable: true },
];

function chatPrompt(id: string, i: number): Prompt {
  for (let k = 0; ; k++) {
    const template = QUESTIONS[(i + k) % QUESTIONS.length]!;
    const brief = makeBrief();
    const outsider = brief.week.draw(pick<Pos>(['RB', 'WR', 'TE']));
    const question = template.ask(brief, outsider.name);
    if (!question) continue;
    return {
      id,
      task: 'chat',
      request: leagueChatRequest(brief.week.team, brief.text, [], question),
      facts: `${brief.text}\n${question}`,
      question,
      ...(template.unanswerable ? { unanswerable: true } : {}),
    };
  }
}

// ---------------------------------------------------------------- write

const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(3, '0')}`;
const prompts: Prompt[] = [
  ...Array.from({ length: 90 }, (_, n) => lineupPrompt(id('L', n + 1))),
  ...Array.from({ length: 60 }, (_, n) => pitchPrompt(id('P', n + 1))),
  ...Array.from({ length: 90 }, (_, n) => chatPrompt(id('C', n + 1), n)),
];

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, 'data');
const sheetDir = join(dataDir, 'sheets');
mkdirSync(sheetDir, { recursive: true });
writeFileSync(join(dataDir, 'prompts.jsonl'), prompts.map((p) => JSON.stringify(p)).join('\n') + '\n', 'utf8');

const sheet = (p: Prompt): string => {
  if (p.task === 'chat') {
    const brief = p.request.system.slice(p.request.system.indexOf('Context:\n') + 'Context:\n'.length);
    return [`### ${p.id} (chat${p.unanswerable ? ', not answerable from the brief' : ''})`, brief, '', `Question: ${p.question}`].join('\n');
  }
  return [`### ${p.id} (${p.task}${p.givesUp ? `, must not name ${p.givesUp}` : ''})`, p.facts].join('\n');
};
const PER_SHEET = 30;
for (let i = 0; i < prompts.length; i += PER_SHEET) {
  const chunk = prompts.slice(i, i + PER_SHEET);
  writeFileSync(join(sheetDir, `${chunk[0]!.id}-${chunk.at(-1)!.id}.md`), chunk.map(sheet).join('\n\n') + '\n', 'utf8');
}
console.log(`${prompts.length} prompts: ${prompts.filter((p) => p.task === 'lineup').length} lineup, ${prompts.filter((p) => p.task === 'pitch').length} pitch, ${prompts.filter((p) => p.task === 'chat').length} chat (${prompts.filter((p) => p.unanswerable).length} unanswerable)`);
