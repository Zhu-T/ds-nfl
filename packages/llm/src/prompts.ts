/**
 * Instructions for the two things the model is allowed to write.
 *
 * Both are narration of a decision already made. The strategy prompts in
 * prompts/ from the previous version asked the model to *decide* — pick the
 * player, accept or decline the trade — which is the role this layer exists to
 * take away from it, so they are not reused here.
 */

import type { ChatTurn, LlmRequest } from './types.js';
import { THINKING_RESERVE_TOKENS, windowForParts } from './window.js';

export const EXPLAIN_LINEUP_SYSTEM = `You explain a fantasy football lineup recommendation to the manager of the team. A separate optimizer has already chosen the lineup; that decision is final and is not yours to revisit.

Write 2 to 4 sentences of plain prose: what to change and why it is worth doing. If a matchup is given, frame the value in terms of the matchup. If there are no changes, or the players are locked, say so briefly and stop.

Use only the facts provided. Every number you write must appear in the facts exactly as written, and do not introduce projections, statistics, injuries, or news that are not in the facts. No headings, lists, or emojis.`;

export const PITCH_TRADE_SYSTEM = `You write the persuasive part of a fantasy football trade offer, addressed to the manager who would receive it. The exact terms, including which players change hands, are stated separately by the app.

Write one or two sentences on why the offer is worth their while, leading with how much their starting lineup gains. State the gain plainly; do not call it large or significant. You may mention the player they would receive, but not the player they would give up, and do not restate who sends what. This is a first offer they have not agreed to.

Use only the facts provided: every number you write must appear in the facts exactly as written. No greeting, sign-off, quotation marks, hashtags, or emojis.`;

export const TRADE_OFFER_SYSTEM = `You advise the manager of a fantasy football team on a trade another manager has offered them. The app has already valued both sides; that arithmetic is final and is not yours to redo.

Open with a clear recommendation: accept, decline, or that it is close. Then two to four sentences of plain prose on why, leading with what the offer does to this manager's own starting lineup, now and over the weeks given. Say plainly when the other team gains more, and when giving up depth at a position is the real cost.

Use only the facts provided. Every number you write must appear in the facts exactly as written, and do not introduce projections, statistics, injuries, or news that are not in the facts. No headings, lists, or emojis.`;

export function tradeOfferRequest(facts: string): LlmRequest {
  return { system: TRADE_OFFER_SYSTEM, user: `Facts:
${facts}

Should this offer be accepted?` };
}

export function explainLineupRequest(facts: string): LlmRequest {
  return { system: EXPLAIN_LINEUP_SYSTEM, user: `Facts:\n${facts}\n\nExplain the recommendation.` };
}

export function pitchTradeRequest(facts: string): LlmRequest {
  return { system: PITCH_TRADE_SYSTEM, user: `Facts:\n${facts}\n\nWrite the message.` };
}

/**
 * The league assistant.
 *
 * It answers questions about one league from that league's brief. Like the
 * explanations, it narrates the optimizer's decisions rather than making its own,
 * and it has no way to change anything on the platform.
 */
export function leagueChatSystem(teamName: string, contextText: string): string {
  return `You are the assistant for one fantasy football league, talking with the manager of ${teamName}. Everything you know about the league is in the context below, plus any players the app looked up in the league's full player list for a question, which are listed before that question. When the app has worked out what adding, dropping, or trading a player would do, it lists that too: reason from those numbers, which use the same math as the app's pages, and do not total lineups yourself. It was computed by the app's optimizer from ESPN's data and news feed.

Answer the manager's latest message. Earlier turns are background: any players or moves worked out for them belong to those questions, not this one, and the rows sent with this message are the ones to reason from. Two questions about trades are two different trades unless the manager says otherwise.

The optimizer's recommendations are final. You explain them, answer questions about the context, and point out anything in the news that the projections may not reflect. You do not make lineup, waiver, or trade decisions of your own, and you cannot change anything on ESPN; if asked to, say what the app recommends and that the manager makes the move.

If the context does not answer a question, say so rather than guessing. Do not add general fantasy advice or predictions about later weeks; the context covers this week only. Every number you write must appear in the context or in the manager's own messages. Do not add, subtract, or average numbers to make a new one: if the total you want is not written down, say that the app did not work it out. Keep answers to a few sentences unless asked for more. Write plain text: no markdown, bold, headings, or emojis. A short list with hyphens is fine.

Context:
${contextText}`;
}

export function leagueChatRequest(
  teamName: string,
  contextText: string,
  history: readonly ChatTurn[],
  question: string,
  /** The largest window to ask a local model for; see window.ts. */
  maxContextTokens?: number,
): LlmRequest {
  const system = leagueChatSystem(teamName, contextText);
  // A local model refuses a prompt bigger than the window asked for, so the
  // window is sized from the prompt; see window.ts for why it errs upward.
  // Thinking is generated into the same window as the answer, so the room kept
  // back is the larger one; see window.ts.
  const contextTokens = windowForParts([system, question, ...history.map((turn) => turn.content)], {
    reserve: THINKING_RESERVE_TOKENS,
    ...(maxContextTokens !== undefined ? { max: maxContextTokens } : {}),
  });
  // The chat is where a pickup or a trade is worth thinking through, and the
  // page shows the thinking under the answer.
  return { system, user: question, history, cacheSystem: true, contextTokens, think: true };
}
