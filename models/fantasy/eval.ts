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
  pitchTradeRequest,
  tradeFacts,
  type LineupFactsInput,
  type LlmRequest,
  type TradeFactsInput,
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
const models: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--runs') runs = Number(args[++i]);
  else models.push(args[i]!);
}
if (models.length === 0) models.push('deepseek-r1:14b', 'ds-nfl-fantasy');

const results: Result[] = [];
for (const model of models) {
  const provider = new OllamaProvider(model);
  // Load the model first so the first scored answer is not charged for it.
  await provider.complete({ system: 'Reply with the word ready.', user: 'Ready?' }).catch(() => undefined);
  for (const c of cases) {
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

const summary: string[] = [];
summary.push(`| model | shown | lineup | pitch | chat | median s | heuristic flags |`);
summary.push(`| --- | --- | --- | --- | --- | --- | --- |`);
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
    `| ${model} | ${rate(mine)} | ${byTask('lineup')} | ${byTask('pitch')} | ${byTask('chat')} | ${(median(mine.map((r) => r.ms)) / 1000).toFixed(1)} | ${flags} |`,
  );
}

console.log(`\n${summary.join('\n')}`);

const transcript: string[] = [`# Model eval, ${new Date().toISOString()}`, '', `${runs} runs per case.`, '', ...summary, ''];
for (const c of cases) {
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
