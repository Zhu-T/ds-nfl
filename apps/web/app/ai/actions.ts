'use server';

import {
  appendToConversation,
  clearConversation,
  clearPlayerLists,
  readConversation,
  type ChatMessage,
} from '@ds-nfl/adapters';
import {
  checkNumbers,
  leagueChatRequest,
  LlmError,
  lookUpPlayers,
  lookupBlock,
  withLookup,
  type LlmText,
} from '@ds-nfl/llm';
import { currentProvider } from '@/lib/ai';
import { buildLeagueContext } from '@/lib/league-context';
import { whatIfsFor } from '@/lib/what-if';

export interface ChatState {
  readonly messages: readonly ChatMessage[];
  readonly error?: string;
}

/** Earlier turns sent with each question; older ones stay saved but unsent. */
const TURNS_SENT = 12;

/**
 * Ask the league assistant a question, or clear its conversation.
 *
 * The brief is rebuilt from ESPN (or reused if under two minutes old), and every
 * answer goes through the number guard: numbers may come from the league brief
 * or from anything the manager has typed, and nowhere else. An answer that
 * fails twice is kept in the log as withheld, so the question is not lost, but
 * is never shown as fact or fed back into later turns.
 *
 * Before asking, the app looks up the players, fantasy teams, and positions the
 * question names in the league's saved player list, and sends those rows with
 * it. A follow-up that names no one ("is he worth a claim?") gets the rows the
 * question before it named. The rows are saved with the question, so later
 * answers may quote them too.
 */
export async function leagueChat(prev: ChatState, form: FormData): Promise<ChatState> {
  const key = String(form.get('league') ?? '');
  if (!key) return { messages: prev.messages, error: 'Reload the page and try again.' };

  if (form.get('intent') === 'clear') {
    clearConversation(key);
    return { messages: [] };
  }

  const question = String(form.get('question') ?? '').trim();
  if (!question) return { messages: prev.messages, error: 'Type a question first.' };

  let provider;
  try {
    provider = currentProvider('chat');
  } catch (error) {
    return { messages: prev.messages, error: messageOf(error) };
  }
  if (!provider) {
    return { messages: prev.messages, error: 'AI is off. Turn it on under Connect a league.' };
  }

  // The league this page was showing, even if another has been made active since.
  const ctx = await buildLeagueContext(key, Number(form.get('week')) || null);
  if (ctx.state !== 'ok') {
    return {
      messages: prev.messages,
      error: ctx.state === 'error' ? ctx.message : 'That league is no longer connected. Reload the page.',
    };
  }

  const past = readConversation(key);
  const history = past
    .filter((m) => !m.withheld)
    .slice(-TURNS_SENT)
    .map(({ role, content }) => ({ role, content }));
  const list = ctx.view.playerList;
  const lastQuestion = [...past].reverse().find((m) => m.role === 'user')?.content;
  let found = list ? lookUpPlayers(question, list.players) : [];
  if (found.length === 0 && list && lastQuestion) found = lookUpPlayers(lastQuestion, list.players);
  const looked = list ? lookupBlock(found, stamp(list.updatedAt)) : '';
  // Adding, dropping, or trading the players it names, worked out with the app's own math.
  const worked = await whatIfsFor(key, ctx.view.week, question, list).catch(() => ({ block: '', names: [] as string[] }));
  const block = [looked, worked.block].filter(Boolean).join('\n\n');
  const covered = [...new Set([...found.map((p) => p.name), ...worked.names])];

  const allowed = [
    ctx.view.text,
    ...past.filter((m) => m.role === 'user').flatMap((m) => [m.content, m.lookup ?? '']),
    question,
    block,
  ].join('\n');

  const asked: ChatMessage = {
    role: 'user',
    content: question,
    at: new Date().toISOString(),
    ...(block ? { lookedUp: covered, lookup: block } : {}),
  };
  let invented: readonly number[] = [];
  let author = '';

  for (let attempt = 0; attempt < 2; attempt++) {
    const ask =
      attempt === 0
        ? question
        : `${question}\n\n(Your last answer used numbers that are not in the context or in my messages: ${invented.join(', ')}. Answer again using only those numbers.)`;

    let out: LlmText;
    try {
      out = await provider.complete(leagueChatRequest(ctx.view.teamName, ctx.view.text, history, withLookup(ask, block)));
    } catch (error) {
      return { messages: prev.messages, error: messageOf(error) };
    }
    author = out.provider === 'claude' ? `Claude (${out.model})` : `${out.model}, running locally`;
    // The page shows plain text; bold markers some models add anyway would show as asterisks.
    const text = out.text.split('**').join('').trim();

    const guard = checkNumbers(text, allowed);
    if (guard.ok) {
      const reply: ChatMessage = {
        role: 'assistant',
        content: text,
        at: new Date().toISOString(),
        author,
        ...(out.reasoning ? { reasoning: out.reasoning.slice(0, 12_000) } : {}),
      };
      return { messages: appendToConversation(key, [asked, reply]) };
    }
    invented = guard.invented;
  }

  const withheld: ChatMessage = {
    role: 'assistant',
    content: `The answer used numbers the league data does not contain (${invented.join(', ')}), so it is not shown. Try asking another way.`,
    at: new Date().toISOString(),
    author,
    withheld: true,
  };
  return { messages: appendToConversation(key, [asked, withheld]) };
}

/** Rebuild the league's player list now, rather than when it next goes stale. */
export async function refreshPlayerList(form: FormData): Promise<void> {
  const key = String(form.get('league') ?? '');
  if (key) clearPlayerLists(key);
}

/** "Sep 15, 10:40 AM". */
function stamp(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function messageOf(error: unknown): string {
  if (error instanceof LlmError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
