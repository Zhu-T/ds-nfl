/**
 * Making a chat request fit the model's window.
 *
 * The brief grows with the league and the conversation grows with use, so a
 * long chat eventually asks for more than the window allows. Refusing to answer
 * is the worst outcome, so parts are dropped instead, least useful first, and
 * the caller is told what went.
 *
 * Never dropped: the week's facts, the roster, the question, and the looked-up
 * and what-if rows. Those rows are what the number guard checks an answer
 * against (see guard.ts), so trimming them would turn good answers into
 * withheld ones.
 */

import type { ContextSection } from './context.js';
import type { ChatTurn } from './types.js';
import { charBudget, estimateTokens, DEFAULT_RESERVE_TOKENS, DEFAULT_MAX_WINDOW_TOKENS } from './window.js';

/** Sections given up first, in order, when the prompt will not fit. */
const DROP_ORDER: readonly { readonly title: string; readonly said: string }[] = [
  { title: 'Available players', said: 'the list of available players' },
  { title: 'Trade ideas', said: 'the trade ideas' },
  { title: 'Recent news', said: 'the recent news' },
  { title: 'Waiver wire', said: 'the waiver wire list' },
];

export interface FitInput {
  readonly sections: readonly ContextSection[];
  /** The line above the sections, e.g. "Team: DeeboSeek Samuel." */
  readonly lead: string;
  readonly history: readonly ChatTurn[];
  /** The question and the rows quoted with it; both are always kept. */
  readonly question: string;
  readonly fixed?: string;
  readonly max?: number;
  readonly reserve?: number;
}

export interface FitResult {
  /** The context text to put in the system prompt. */
  readonly text: string;
  readonly history: readonly ChatTurn[];
  /** What was left out, in plain words, for the answer to mention. */
  readonly dropped: readonly string[];
}

const sectionText = (lead: string, sections: readonly ContextSection[]) =>
  [lead, ...sections.map((s) => `## ${s.title}\n${s.body}`)].join('\n\n');

/**
 * The most of this request that fits: oldest turns go first, then whole
 * sections in `DROP_ORDER`. What is left always includes the question.
 */
export function fitToWindow(input: FitInput): FitResult {
  const max = input.max ?? DEFAULT_MAX_WINDOW_TOKENS;
  const reserve = input.reserve ?? DEFAULT_RESERVE_TOKENS;
  const budget = charBudget(max, { reserve });
  const dropped: string[] = [];

  let sections = [...input.sections];
  let history = [...input.history];
  const fixedChars = input.question.length + (input.fixed?.length ?? 0);
  const size = () => sectionText(input.lead, sections).length + history.reduce((n, t) => n + t.content.length, 0) + fixedChars;

  // Earlier turns first: the brief answers most questions on its own.
  let turnsDropped = 0;
  while (size() > budget && history.length > 0) {
    history = history.slice(1);
    turnsDropped += 1;
  }
  if (turnsDropped > 0) {
    dropped.push(turnsDropped === 1 ? 'the oldest message in this chat' : `the ${turnsDropped} oldest messages in this chat`);
  }

  for (const { title, said } of DROP_ORDER) {
    if (size() <= budget) break;
    if (!sections.some((s) => s.title === title)) continue;
    sections = sections.filter((s) => s.title !== title);
    dropped.push(said);
  }

  return { text: sectionText(input.lead, sections), history, dropped };
}

/** "Left out to fit the model's context: the oldest messages and the trade ideas." */
export function droppedNote(dropped: readonly string[]): string {
  if (dropped.length === 0) return '';
  const list =
    dropped.length === 1 ? dropped[0]! : `${dropped.slice(0, -1).join(', ')} and ${dropped[dropped.length - 1]}`;
  return `Left out to fit this model's context: ${list}.`;
}

/** Whether a prompt of these parts fits a window, for callers that only need the answer. */
export function fitsWindow(parts: readonly string[], max: number, reserve = DEFAULT_RESERVE_TOKENS): boolean {
  return parts.reduce((total, part) => total + estimateTokens(part), 0) + reserve <= max;
}
