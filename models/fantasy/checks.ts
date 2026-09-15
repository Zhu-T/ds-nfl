/**
 * How an answer is judged: the checks the app runs before showing one, plus
 * heuristics for the failures those checks cannot see. Shared by the eval and
 * the LoRA dataset builder, so training data is held to the bar the eval measures.
 */

import { checkNumbers, namesIn, pitchReasonOk } from '../../packages/llm/src/index.js';

export type Task = 'lineup' | 'pitch' | 'chat';

export interface Checkable {
  readonly task: Task;
  /** What the number guard checks against, as in the app. */
  readonly facts: string;
  /** Pitches only: the player the recipient would give up, which must not be named. */
  readonly givesUp?: string;
  /** Chat only: the brief cannot answer this, and the answer should say so. */
  readonly unanswerable?: boolean;
}

export interface Verdict {
  /** Passes the checks the app runs before showing the text. */
  readonly shown: boolean;
  readonly flags: string[];
}

const NFL_TEAMS: Record<string, string> = {
  ARI: 'Cardinals', ATL: 'Falcons', BAL: 'Ravens', BUF: 'Bills', CAR: 'Panthers', CHI: 'Bears',
  CIN: 'Bengals', CLE: 'Browns', DAL: 'Cowboys', DEN: 'Broncos', DET: 'Lions', GB: 'Packers',
  HOU: 'Texans', IND: 'Colts', JAX: 'Jaguars', KC: 'Chiefs', LV: 'Raiders', LAC: 'Chargers',
  LAR: 'Rams', MIA: 'Dolphins', MIN: 'Vikings', NE: 'Patriots', NO: 'Saints', NYG: 'Giants',
  NYJ: 'Jets', PHI: 'Eagles', PIT: 'Steelers', SF: '49ers', SEA: 'Seahawks', TB: 'Buccaneers',
  TEN: 'Titans', WSH: 'Commanders',
};

const SENTENCES: Record<Task, [number, number] | null> = { lineup: [1, 4], pitch: [1, 2], chat: null };
const OVERSTATES = /\b(significant(ly)?|large|big|huge|massive|major|substantial|strong|solid)\b/i;
const SCOUTING =
  /\b(franchise|dynamic|reliable|explosive|game-changer|game-breaking|signal-caller|bell-?cow|elite|workhorse|proven)\b/i;
const PADDING = /\b(monitor|keep an eye|risk tolerance|stay tuned|injury report|trust your gut|at the end of the day)\b/i;
const ADMITS_GAP =
  /(\bnot\b|n't\b)[^.]{0,60}\b(include|cover|say|have|contain|mention|provide|list|available|know|show)|\bno (information|data|stats|statistics)\b|\bcan(not|'t) (tell|say|answer)/i;

export function score(c: Checkable, text: string): Verdict {
  const flags: string[] = [];
  const invented = checkNumbers(text, c.facts).invented;
  if (invented.length > 0) flags.push(`invented numbers: ${invented.join(', ')}`);
  if (c.givesUp !== undefined && namesIn(text, [c.givesUp]).length > 0) flags.push(`names the player given up: ${c.givesUp}`);
  const shown = c.givesUp !== undefined ? pitchReasonOk(text, c.facts, c.givesUp) : invented.length === 0;

  // Heuristics: the app does not check these, but they are the known weak spots.
  if (/\*\*|__|^#{1,6}\s|`/m.test(text)) flags.push('markdown');
  if (/\p{Extended_Pictographic}/u.test(text)) flags.push('emoji');
  if (c.task !== 'chat' && /^\s*[-*•]\s/m.test(text)) flags.push('list');
  const range = SENTENCES[c.task];
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim()).length;
  if (range && (sentences < range[0] || sentences > range[1])) flags.push(`length: ${sentences} sentences`);
  for (const [abbr, nickname] of Object.entries(NFL_TEAMS)) {
    const known = new RegExp(`\\b${abbr}\\b`).test(c.facts) || c.facts.includes(nickname);
    if (!known && new RegExp(`\\b${nickname}\\b`).test(text)) flags.push(`outside knowledge: the ${nickname}`);
  }
  // The pitch prompt says to state the gain plainly, not call it large or significant.
  if (c.task === 'pitch' && OVERSTATES.test(text)) flags.push('overstates the gain');
  // Player descriptions the facts never give, so they can only come from the model's stale memory.
  if (SCOUTING.test(text)) flags.push('scouting claim');
  if (PADDING.test(text)) flags.push('generic advice');
  if (c.unanswerable && !ADMITS_GAP.test(text)) flags.push('does not say the brief lacks this');
  return { shown, flags };
}
