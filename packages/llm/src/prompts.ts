/**
 * Instructions for the two things the model is allowed to write.
 *
 * Both are narration of a decision already made. The strategy prompts in
 * prompts/ from the previous version asked the model to *decide* — pick the
 * player, accept or decline the trade — which is the role this layer exists to
 * take away from it, so they are not reused here.
 */

import type { ChatTurn, LlmRequest } from './types.js';

export const EXPLAIN_LINEUP_SYSTEM = `You explain a fantasy football lineup recommendation to the manager of the team. A separate optimizer has already chosen the lineup; that decision is final and is not yours to revisit.

Write 2 to 4 sentences of plain prose: what to change and why it is worth doing. If a matchup is given, frame the value in terms of the matchup. If there are no changes, or the players are locked, say so briefly and stop.

Use only the facts provided. Every number you write must appear in the facts exactly as written, and do not introduce projections, statistics, injuries, or news that are not in the facts. No headings, lists, or emojis.`;

export const PITCH_TRADE_SYSTEM = `You write the persuasive part of a fantasy football trade offer, addressed to the manager who would receive it. The exact terms, including which players change hands, are stated separately by the app.

Write one or two sentences on why the offer is worth their while, leading with how much their starting lineup gains. State the gain plainly; do not call it large or significant. You may mention the player they would receive, but not the player they would give up, and do not restate who sends what. This is a first offer they have not agreed to.

Use only the facts provided: every number you write must appear in the facts exactly as written. No greeting, sign-off, quotation marks, hashtags, or emojis.`;

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
  return `You are the assistant for one fantasy football league, talking with the manager of ${teamName}. Everything you know about the league is in the context below, plus any players the app looked up in the league's full player list for a question, which are listed before that question. It was computed by the app's optimizer from ESPN's data and news feed.

The optimizer's recommendations are final. You explain them, answer questions about the context, and point out anything in the news that the projections may not reflect. You do not make lineup, waiver, or trade decisions of your own, and you cannot change anything on ESPN; if asked to, say what the app recommends and that the manager makes the move.

If the context does not answer a question, say so rather than guessing. Do not add general fantasy advice or predictions about later weeks; the context covers this week only. Every number you write must appear in the context or in the manager's own messages. Keep answers to a few sentences unless asked for more. Write plain text: no markdown, bold, headings, or emojis. A short list with hyphens is fine.

Context:
${contextText}`;
}

export function leagueChatRequest(
  teamName: string,
  contextText: string,
  history: readonly ChatTurn[],
  question: string,
): LlmRequest {
  const system = leagueChatSystem(teamName, contextText);
  // Ollama cuts long prompts off silently unless asked for a bigger window:
  // about three characters per token, plus room for the answer.
  const chars = system.length + question.length + history.reduce((total, turn) => total + turn.content.length, 0);
  const contextTokens = Math.min(32_768, Math.max(8_192, Math.ceil((Math.ceil(chars / 3) + 2_000) / 4_096) * 4_096));
  return { system, user: question, history, cacheSystem: true, contextTokens };
}
