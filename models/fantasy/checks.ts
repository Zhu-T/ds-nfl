/**
 * How an answer is judged: the checks the app runs before showing one, plus
 * heuristics for the failures those checks cannot see. Shared by the eval and
 * the LoRA dataset builder, so training data is held to the bar the eval measures.
 */

import {
  checkNumbers,
  namesIn,
  parseNewsFindings,
  parseWaiverPicks,
  pitchReasonOk,
  type ResearchPlayer,
  type ResearchSource,
} from '../../packages/llm/src/index.js';
import { FACTOR_RANGE, type NewsStatus } from '../../packages/core/src/index.js';

export type Task = 'lineup' | 'pitch' | 'chat' | 'news' | 'picks';

export interface Checkable {
  readonly task: Task;
  /** What the number guard checks against, as in the app. */
  readonly facts: string;
  /** Pitches only: the player the recipient would give up, which must not be named. */
  readonly givesUp?: string;
  /** Chat only: the brief cannot answer this, and the answer should say so. */
  readonly unanswerable?: boolean;
  /**
   * JSON tasks: what the app's parser needs, and the players the fixture's items
   * support. The answer is judged by the app's own parser, not by prose checks.
   */
  readonly json?: {
    readonly players?: readonly ResearchPlayer[];
    readonly sources: readonly ResearchSource[];
    readonly expected: readonly string[];
  };
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

/**
 * A JSON answer: the app parses it rather than showing it, so "shown" means the
 * parser accepted it. The fence is checked separately — the app tolerates a
 * missing one now, but it is the format the prompt asks for and what we teach.
 */
function scoreJson(c: Checkable, text: string): Verdict {
  const flags: string[] = [];
  const json = c.json!;
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  if (fences.length === 0) flags.push('no fenced block');
  else {
    if (fences.length > 1) flags.push(`${fences.length} fenced blocks`);
    const after = text.slice(text.lastIndexOf('```') + 3).trim();
    if (after) flags.push(`text after the block: ${after.slice(0, 40)}`);
  }

  let named: string[];
  let rejected: readonly { readonly player: string; readonly reason: string }[];
  try {
    if (c.task === 'news') {
      const parsed = parseNewsFindings(text, json.players ?? [], json.sources, { numbered: true });
      named = parsed.findings.map((f) => f.playerName);
      rejected = parsed.rejected;
      // The parser clamps a factor into its range; an answer should not need it.
      for (const raw of rawItems(text, 'findings')) {
        const status = String(raw['status']);
        const factor = raw['factor'];
        const range = FACTOR_RANGE[status as NewsStatus];
        if (range && typeof factor === 'number' && (factor < range[0] || factor > range[1])) {
          flags.push(`factor ${factor} outside ${status} ${range[0]}-${range[1]}`);
        }
      }
    } else {
      const parsed = parseWaiverPicks(text, json.sources, { numbered: true });
      named = parsed.picks.map((p) => p.name);
      rejected = parsed.rejected;
      // The picks parser takes any name, so an invented one only shows up here.
      for (const name of named) {
        if (!c.facts.toLowerCase().includes(name.toLowerCase())) flags.push(`not named in the items: ${name}`);
      }
    }
  } catch (error) {
    flags.push(`parser: ${error instanceof Error ? error.message : String(error)}`);
    return { shown: false, flags };
  }

  for (const r of rejected) flags.push(`dropped ${r.player}: ${r.reason}`);
  const lower = (xs: readonly string[]) => xs.map((x) => x.toLowerCase());
  const missed = json.expected.filter((name) => !lower(named).includes(name.toLowerCase()));
  const extra = named.filter((name) => !lower(json.expected).includes(name.toLowerCase()));
  if (missed.length > 0) flags.push(`missed: ${missed.join(', ')}`);
  if (extra.length > 0) flags.push(`the items do not support: ${extra.join(', ')}`);
  return { shown: true, flags };
}

/** The objects under a key in the answer's last JSON block, for checks the parser does not make. */
function rawItems(text: string, key: 'findings' | 'picks'): Record<string, unknown>[] {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  const body = fences.at(-1)?.[1] ?? text.slice(text.lastIndexOf(`{"${key}"`));
  try {
    const parsed = JSON.parse(body.trim()) as Record<string, unknown>;
    const items = parsed[key];
    return Array.isArray(items) ? (items.filter((x) => x && typeof x === 'object') as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
}

export function score(c: Checkable, text: string): Verdict {
  if (c.task === 'news' || c.task === 'picks') return scoreJson(c, text);
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
