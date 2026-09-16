/**
 * Joins the training prompts with their written answers, holds every answer to
 * the eval's checks, and writes the train and validation sets.
 *
 *   npx vite-node models/fantasy/lora/build-dataset.ts
 *
 * An answer that fails any check, the app's own or a heuristic, is left out and
 * listed rather than trained on.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { score, type Checkable } from '../checks.js';

interface PromptRow extends Checkable {
  readonly id: string;
  readonly request: { readonly system: string; readonly user: string };
}

interface AnswerRow {
  readonly id: string;
  readonly answer: string;
}

// Rendered exactly as Ollama's template for deepseek-r1:14b renders an app request
// (bos, system, user turn, assistant turn), so training sees the text inference will.
const BOS = '<｜begin▁of▁sentence｜>';
const USER = '<｜User｜>';
const ASSISTANT = '<｜Assistant｜>';
const EOS = '<｜end▁of▁sentence｜>';

const render = (p: PromptRow): string => `${BOS}${p.request.system}${USER}${p.request.user}${ASSISTANT}`;
// An empty think block before the answer teaches the model to answer without
// reasoning first, which `think: false` fails to make it do (see README).
const completion = (answer: string): string => `<think>\n\n</think>\n\n${answer}${EOS}`;

const readJsonl = <T,>(path: string): T[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);

const dataDir = join(dirname(fileURLToPath(import.meta.url)), 'data');
const prompts = readJsonl<PromptRow>(join(dataDir, 'prompts.jsonl'));
// Hand-written answers for the prose tasks, and the JSON tasks' answers, which
// make-prompts.ts generates from the same fixtures it builds the prompts from.
const written = readJsonl<AnswerRow>(join(dataDir, 'answers.jsonl'));
const generatedPath = join(dataDir, 'answers-generated.jsonl');
const generated = existsSync(generatedPath) ? readJsonl<AnswerRow>(generatedPath) : [];
const answers = new Map([...written, ...generated].map((a) => [a.id, a.answer.trim()]));

const kept: { id: string; task: string; prompt: string; completion: string }[] = [];
const rejected: string[] = [];
const missing: string[] = [];
for (const p of prompts) {
  const answer = answers.get(p.id);
  if (!answer) {
    missing.push(p.id);
    continue;
  }
  const verdict = score(p, answer);
  if (!verdict.shown || verdict.flags.length > 0) {
    rejected.push(`${p.id}: ${verdict.shown ? '' : 'withheld; '}${verdict.flags.join('; ')}`);
    continue;
  }
  kept.push({ id: p.id, task: p.task, prompt: render(p), completion: completion(answer) });
}

// Every tenth example is held out, which spreads the validation set across tasks.
const train = kept.filter((_, i) => i % 10 !== 9);
const val = kept.filter((_, i) => i % 10 === 9);
const jsonl = (rows: object[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
writeFileSync(join(dataDir, 'train.jsonl'), jsonl(train), 'utf8');
writeFileSync(join(dataDir, 'val.jsonl'), jsonl(val), 'utf8');

const byTask = (task: string): number => kept.filter((k) => k.task === task).length;
console.log(
  `${kept.length} kept (lineup ${byTask('lineup')}, pitch ${byTask('pitch')}, chat ${byTask('chat')}, ` +
    `news ${byTask('news')}, picks ${byTask('picks')}): ${train.length} train, ${val.length} val`,
);
if (missing.length > 0) console.log(`${missing.length} prompts have no answer yet: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', ...' : ''}`);
if (rejected.length > 0) console.log(`${rejected.length} rejected:\n  ${rejected.join('\n  ')}`);
