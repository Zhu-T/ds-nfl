/**
 * Compare local models on the three things the app asks a model to write.
 *
 *   node_modules/.bin/vite-node models/fantasy/eval.ts
 *   node_modules/.bin/vite-node models/fantasy/eval.ts -- --runs 5 deepseek-r1:14b ds-nfl-fantasy
 *
 * Requests go through the app's own OllamaProvider, prompts, and fact builders,
 * so a model's Modelfile SYSTEM reaches it exactly as it does in the app. Each
 * answer is scored by the checks the app runs before showing one, plus
 * heuristics for failures those checks cannot see. The app retries a chat
 * answer once when it is withheld; this scores single attempts. A transcript of
 * every answer is written to models/fantasy/results/.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OllamaProvider,
  explainLineupRequest,
  leagueChatRequest,
  leagueContext,
  lineupFacts,
  newsDigestRequest,
  pitchTradeRequest,
  tradeFacts,
  waiverPicksDigestRequest,
  type DigestItem,
  type LineupFactsInput,
  type LlmRequest,
  type ResearchPlayer,
  type TradeFactsInput,
  type WaiverArticle,
} from '../../packages/llm/src/index.js';
import { score, type Checkable, type Task } from './checks.js';

interface Case extends Checkable {
  readonly id: string;
  readonly request: LlmRequest;
}

// ---------------------------------------------------------------- fixtures

const TEAM = 'Sunday Scaries';

const lineups: Record<string, LineupFactsInput> = {
  'lineup-changes': {
    leagueName: 'Group Chat League',
    format: 'PPR',
    week: 3,
    currentPoints: 104.2,
    optimizedPoints: 118.9,
    pointsGained: 14.7,
    moves: [
      { slot: 'WR', outName: 'Tee Higgins', outProjected: 0, outNote: 'Out', inName: 'Jakobi Meyers', inPosition: 'WR', inProjected: 11.6 },
      { slot: 'FLEX', outName: 'Tyler Allgeier', outProjected: 6.8, inName: 'Rhamondre Stevenson', inPosition: 'RB', inProjected: 9.9 },
    ],
    lockedPlayers: [],
    flagged: [],
    matchup: { opponent: 'Ceebee', opponentProjected: 112.5, marginNow: -8.3, marginAfter: 6.4 },
  },
  'lineup-none-locked': {
    leagueName: 'Group Chat League',
    format: 'Half PPR',
    week: 3,
    currentPoints: 121.4,
    optimizedPoints: 121.4,
    pointsGained: 0,
    moves: [],
    lockedPlayers: ['Jalen Hurts', 'DeVonta Smith'],
    flagged: [],
    matchup: { opponent: 'Ceebee', opponentProjected: 109.0, marginNow: 12.4, marginAfter: 12.4 },
  },
  'lineup-planning': {
    leagueName: 'Work League',
    format: 'PPR',
    week: 4,
    planningAhead: true,
    currentPoints: 98.1,
    optimizedPoints: 101.6,
    pointsGained: 3.5,
    moves: [
      { slot: 'TE', outName: 'Pat Freiermuth', outProjected: 6.2, inName: 'Dalton Kincaid', inPosition: 'TE', inProjected: 9.7 },
    ],
    lockedPlayers: [],
    flagged: [{ name: 'Christian McCaffrey', note: 'Questionable' }],
    matchup: { opponent: 'The Replacements', opponentProjected: 104.0, opponentBest: true, marginNow: -5.9, marginAfter: -2.4 },
  },
};

const trades: Record<string, TradeFactsInput> = {
  // The trade a local model reversed in two of six live drafts.
  'pitch-qb': {
    week: 1,
    myTeam: "Tony's Personal Computer",
    opponentTeam: 'Ceebee',
    give: 'Trevor Lawrence',
    giveProjected: 18.4,
    get: 'Tee Higgins',
    getProjected: 10.8,
    theirGain: 0.3,
  },
  'pitch-rb': {
    week: 3,
    myTeam: TEAM,
    opponentTeam: 'The Replacements',
    give: 'James Cook',
    giveProjected: 13.8,
    get: 'DK Metcalf',
    getProjected: 12.1,
    theirGain: 4.6,
  },
};

const brief = leagueContext({
  teamName: TEAM,
  weekLabel: 'Week 3',
  lineupFacts: lineupFacts(lineups['lineup-changes']!),
  roster: [
    { name: 'Jalen Hurts', position: 'QB', slot: 'QB', projected: 21.3, proTeam: 'PHI' },
    { name: 'Bijan Robinson', position: 'RB', slot: 'RB', projected: 17.2, proTeam: 'ATL' },
    { name: 'Kyren Williams', position: 'RB', slot: 'RB', projected: 14.0, proTeam: 'LAR' },
    { name: 'Garrett Wilson', position: 'WR', slot: 'WR', projected: 15.1, proTeam: 'NYJ' },
    { name: 'Tee Higgins', position: 'WR', slot: 'WR', projected: 0, proTeam: 'CIN', note: 'Out' },
    { name: 'Trey McBride', position: 'TE', slot: 'TE', projected: 12.4, proTeam: 'ARI' },
    { name: 'Tyler Allgeier', position: 'RB', slot: 'FLEX', projected: 6.8, proTeam: 'ATL' },
    { name: 'Jake Elliott', position: 'K', slot: 'K', projected: 8.3, proTeam: 'PHI' },
    { name: 'Steelers D/ST', position: 'DST', slot: 'DST', projected: 9.1, proTeam: 'PIT' },
    { name: 'Jakobi Meyers', position: 'WR', slot: 'BENCH', projected: 11.6, proTeam: 'LV' },
    { name: 'Rhamondre Stevenson', position: 'RB', slot: 'BENCH', projected: 9.9, proTeam: 'NE' },
    { name: 'Trevor Lawrence', position: 'QB', slot: 'BENCH', projected: 16.0, proTeam: 'JAX' },
  ],
  waivers: [
    { name: 'Rashid Shaheed', position: 'WR', projected: 13.1, gain: 3.2, pickup: 'free-agent' },
    { name: 'Jaylen Warren', position: 'RB', projected: 11.3, gain: 1.4, pickup: 'waivers' },
  ],
  trades: [{ give: 'Trevor Lawrence', get: 'Chris Olave', opponent: 'Ceebee', myGain: 2.2, theirGain: 5.0 }],
  news: [
    {
      player: 'Tee Higgins',
      published: '2026-09-12',
      headline: 'Higgins ruled out for Week 3',
      story: 'Higgins will miss the game with a hamstring injury.',
    },
    { player: 'Bijan Robinson', published: '2026-09-11', headline: 'Robinson a full participant in practice', story: '' },
  ],
}).text;

const questions: { id: string; question: string; unanswerable?: boolean }[] = [
  { id: 'chat-waivers', question: 'Is anyone on waivers worth picking up?' },
  { id: 'chat-matchup', question: 'Am I going to beat Ceebee this week?' },
  { id: 'chat-unknown', question: 'How many touchdowns did Garrett Wilson score last season?', unanswerable: true },
];

// ---------------------------------------------------------------- json tasks

/**
 * The two tasks whose answer the app parses rather than shows. The items say
 * exactly what a correct answer reports, so `expected` is the fixture's own
 * answer, and anything more or less is flagged. Players here appear nowhere in
 * the training data, as with the prose cases.
 */

const WEEK = 3;
const TODAY = '2026-09-15';

const newsCases: { id: string; players: ResearchPlayer[]; items: DigestItem[]; expected: string[] }[] = [
  {
    id: 'news-mixed',
    players: [
      { id: '1', name: 'Tee Higgins', position: 'WR', proTeam: 'CIN', projected: 11.2, role: 'starter' },
      { id: '2', name: 'Trevor Lawrence', position: 'QB', proTeam: 'JAX', projected: 18.4, role: 'starter' },
      { id: '3', name: 'Trey McBride', position: 'TE', proTeam: 'ARI', projected: 12.4, role: 'starter' },
      { id: '4', name: 'Jaylen Warren', position: 'RB', proTeam: 'PIT', projected: 8.6, role: 'pickup' },
    ],
    items: [
      { playerId: '1', url: 'https://example.com/a1', source: 'ESPN', published: '2026-09-12', title: 'Higgins ruled out for Week 3', text: 'Tee Higgins will not play in Week 3 because of a hamstring injury.' },
      { playerId: '2', url: 'https://example.com/a2', source: 'NBC Sports', published: '2026-09-11', title: 'Lawrence limited in practice', text: 'Trevor Lawrence was limited in practice with an ankle injury and is listed as questionable for Week 3.' },
      { playerId: '3', url: 'https://example.com/a3', source: 'The Athletic', published: '2026-09-09', title: 'McBride limited in practice', text: 'Trey McBride was limited on Wednesday with a back injury.' },
      { playerId: '3', url: 'https://example.com/a4', source: 'ESPN', published: '2026-09-13', title: 'McBride a full participant', text: 'Trey McBride practiced in full on Friday and carries no designation into Week 3.' },
      { playerId: '4', url: 'https://example.com/a5', source: 'Yahoo Sports', published: '2026-09-10', title: 'Warren quiet in the loss', text: 'Jaylen Warren carried four times in last week&apos;s game.' },
    ],
    expected: ['Tee Higgins', 'Trevor Lawrence'],
  },
  {
    id: 'news-role',
    players: [
      {
        id: '1',
        name: 'Tyler Allgeier',
        position: 'RB',
        proTeam: 'ATL',
        projected: 6.8,
        role: 'pickup',
        context: 'Bijan Robinson, ahead of them at RB, is out',
      },
      { id: '2', name: 'Jakobi Meyers', position: 'WR', proTeam: 'LV', projected: 11.6, role: 'bench' },
    ],
    items: [
      { playerId: '1', url: 'https://example.com/b1', source: 'ESPN', published: '2026-09-13', title: 'Allgeier in line for the lead role', text: 'With Bijan Robinson out, the coaching staff said Tyler Allgeier will handle the starter&apos;s work in Week 3.' },
    ],
    expected: ['Tyler Allgeier'],
  },
  {
    id: 'news-quiet',
    players: [
      { id: '1', name: 'Garrett Wilson', position: 'WR', proTeam: 'NYJ', projected: 15.1, role: 'starter' },
      { id: '2', name: 'Rhamondre Stevenson', position: 'RB', proTeam: 'NE', projected: 9.9, role: 'bench' },
    ],
    items: [
      { playerId: '1', url: 'https://example.com/c1', source: 'CBS Sports', published: '2026-09-11', title: 'Wilson catches five passes', text: 'Garrett Wilson caught five passes in last week&apos;s game.' },
      { playerId: '2', url: 'https://example.com/c2', source: 'RotoBaller', published: '2026-09-10', title: 'Stevenson splits the backfield', text: 'Rhamondre Stevenson split carries evenly last week, and the team expects that to continue.' },
    ],
    expected: [],
  },
];

const picksCases: { id: string; items: WaiverArticle[]; expected: string[] }[] = [
  {
    id: 'picks-adds',
    items: [
      { url: 'https://example.com/w1', source: 'FantasyPros', published: '2026-09-14', title: 'Week 3 waiver wire: Rashid Shaheed, Jaylen Warren lead the adds', text: 'Rashid Shaheed (WR) is worth a claim after a starter ahead of him went down. Jaylen Warren (RB) has taken over the lead role.' },
      { url: 'https://example.com/w2', source: 'CBS Sports', published: '2026-09-13', title: 'Add Rashid Shaheed before Week 3' },
      { url: 'https://example.com/w3', source: 'Yahoo Sports', published: '2026-09-13', title: 'Week 3 streaming defenses: start Steelers D/ST', text: 'Steelers D/ST is the best streaming defense available for Week 3.' },
      { url: 'https://example.com/w4', source: 'ESPN', published: '2026-09-12', title: 'Week 3 drop candidates: Jerome Ford and Adam Thielen', text: 'Jerome Ford and Adam Thielen can be cut loose in most leagues.' },
      { url: 'https://example.com/w5', source: 'RotoBaller', published: '2026-09-12', title: 'College football: Carson Beck headlines Saturday&apos;s slate', text: 'Carson Beck threw for three touchdowns in a college game.' },
      { url: 'https://example.com/w6', source: 'The Athletic', published: '2026-09-11', title: 'Week 8 preview: Jaleel McLaughlin could matter later', text: 'Jaleel McLaughlin is worth stashing for Week 8, not for Week 3.' },
    ],
    expected: ['Rashid Shaheed', 'Jaylen Warren', 'Steelers D/ST'],
  },
  {
    id: 'picks-quiet',
    items: [
      { url: 'https://example.com/x1', source: 'ESPN', published: '2026-09-13', title: 'Week 3 drop candidates: Jerome Ford and Adam Thielen', text: 'Jerome Ford and Adam Thielen can be cut loose in most leagues.' },
      { url: 'https://example.com/x2', source: 'RotoBaller', published: '2026-09-12', title: 'College football: Dylan Raiola headlines Saturday&apos;s slate', text: 'Dylan Raiola threw for three touchdowns in a college game.' },
      { url: 'https://example.com/x3', source: 'CBS Sports', published: '2026-09-11', title: 'Week 9 preview: Jaleel McLaughlin could matter later', text: 'Jaleel McLaughlin is worth stashing for Week 9, not for Week 3.' },
    ],
    expected: [],
  },
];

const cases: Case[] = [
  ...Object.entries(lineups).map(([id, input]): Case => {
    const facts = lineupFacts(input);
    return { id, task: 'lineup', request: explainLineupRequest(facts), facts };
  }),
  ...Object.entries(trades).map(([id, input]): Case => {
    const facts = tradeFacts(input);
    return { id, task: 'pitch', request: pitchTradeRequest(facts), facts, givesUp: input.get };
  }),
  ...questions.map(({ id, question, unanswerable }): Case => ({
    id,
    task: 'chat',
    request: leagueChatRequest(TEAM, brief, [], question),
    // The app accepts numbers from the brief or from the manager's own messages.
    facts: `${brief}\n${question}`,
    ...(unanswerable ? { unanswerable } : {}),
  })),
  ...newsCases.map((n): Case => {
    const { request, sources } = newsDigestRequest({
      leagueName: 'Group Chat League',
      week: WEEK,
      today: TODAY,
      players: n.players,
      items: n.items,
    });
    return { id: n.id, task: 'news', request, facts: `${request.system}\n${request.user}`, json: { players: n.players, sources, expected: n.expected } };
  }),
  ...picksCases.map((p): Case => {
    const { request, sources } = waiverPicksDigestRequest({ week: WEEK, today: TODAY, items: p.items });
    return { id: p.id, task: 'picks', request, facts: `${request.system}\n${request.user}`, json: { sources, expected: p.expected } };
  }),
];

// ---------------------------------------------------------------- run

interface Result {
  readonly model: string;
  readonly caseId: string;
  readonly task: Task;
  readonly run: number;
  readonly ms: number;
  readonly text: string | null;
  readonly error: string | null;
  readonly shown: boolean;
  readonly flags: string[];
}

const args = process.argv.slice(2).filter((a) => a !== '--');
let runs = 3;
let only: Task[] | null = null;
const models: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--runs') runs = Number(args[++i]);
  else if (args[i] === '--tasks') only = args[++i]!.split(',') as Task[];
  else models.push(args[i]!);
}
if (models.length === 0) models.push('deepseek-r1:14b', 'ds-nfl-fantasy');
const running = only ? cases.filter((c) => only!.includes(c.task)) : cases;

const results: Result[] = [];
for (const model of models) {
  const provider = new OllamaProvider(model);
  // Load the model first so the first scored answer is not charged for it.
  await provider.complete({ system: 'Reply with the word ready.', user: 'Ready?' }).catch(() => undefined);
  for (const c of running) {
    for (let run = 1; run <= runs; run++) {
      const t0 = Date.now();
      let result: Result;
      try {
        const { text } = await provider.complete(c.request);
        result = { model, caseId: c.id, task: c.task, run, ms: Date.now() - t0, text, error: null, ...score(c, text) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result = { model, caseId: c.id, task: c.task, run, ms: Date.now() - t0, text: null, error: message, shown: false, flags: ['error'] };
      }
      results.push(result);
      const tail = result.flags.length > 0 ? ` - ${result.flags.join('; ')}` : '';
      console.log(`${model}  ${c.id} #${run}  ${(result.ms / 1000).toFixed(1)}s  ${result.shown ? 'shown' : 'WITHHELD'}${tail}`);
    }
  }
}

// ---------------------------------------------------------------- report

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)]!;
};
const rate = (rs: Result[]): string => `${rs.filter((r) => r.shown).length}/${rs.length}`;

const TASKS: Task[] = ['lineup', 'pitch', 'chat', 'news', 'picks'];
const shownTasks = TASKS.filter((t) => running.some((c) => c.task === t));
const summary: string[] = [];
summary.push(`| model | shown | ${shownTasks.join(' | ')} | median s | heuristic flags |`);
summary.push(`| --- | --- | ${shownTasks.map(() => '---').join(' | ')} | --- | --- |`);
for (const model of models) {
  const mine = results.filter((r) => r.model === model);
  const byTask = (t: Task) => rate(mine.filter((r) => r.task === t));
  const flagCounts = new Map<string, number>();
  for (const r of mine) {
    for (const f of r.flags) {
      const kind = f.split(':')[0]!;
      flagCounts.set(kind, (flagCounts.get(kind) ?? 0) + 1);
    }
  }
  const flags = [...flagCounts].map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  summary.push(
    `| ${model} | ${rate(mine)} | ${shownTasks.map((t) => byTask(t)).join(' | ')} | ${(median(mine.map((r) => r.ms)) / 1000).toFixed(1)} | ${flags} |`,
  );
}

console.log(`\n${summary.join('\n')}`);

const transcript: string[] = [`# Model eval, ${new Date().toISOString()}`, '', `${runs} runs per case.`, '', ...summary, ''];
for (const c of running) {
  transcript.push(`## ${c.id} (${c.task})`, '', c.task === 'chat' ? `Question: ${questions.find((q) => q.id === c.id)!.question}` : '```', ...(c.task === 'chat' ? [] : [c.facts, '```']), '');
  for (const r of results.filter((x) => x.caseId === c.id)) {
    const tail = r.flags.length > 0 ? ` (${r.flags.join('; ')})` : '';
    transcript.push(`- **${r.model} #${r.run}** ${r.shown ? 'shown' : 'withheld'}${tail}: ${r.text ?? r.error}`);
  }
  transcript.push('');
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'results');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `eval-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
writeFileSync(outFile, transcript.join('\n'), 'utf8');
console.log(`\nTranscript: ${outFile}`);
