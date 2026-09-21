/**
 * Which Ollama model handles which kind of task. Plain functions, safe to test.
 *
 * Writing tasks (chat, lineup explanations, trade pitches) want an answer while
 * you wait. Judgement tasks (the news check, waiver picks, and the news read on
 * Evaluate a player) run in the background and can move projections, so they
 * may use a slower model that reasons.
 *
 * The model is the lever because Ollama's `think` flag is not: probed on Ollama
 * 0.33.3, deepseek-r1:14b reasons with `think` false, true, or omitted, and the
 * ds-nfl-lora fine-tune, trained without reasoning, produces none even with
 * `think: true`.
 */

import type { AiSettings } from '@ds-nfl/adapters';

export type AiTask = 'writing' | 'judgment' | 'chat';

/** The model this machine already had installed for the previous version. */
export const DEFAULT_OLLAMA_MODEL = 'deepseek-r1:14b';

/**
 * The Ollama model for a task. With no judgement or chat model saved, every
 * task uses the same one, as before. Chat may use a model that reasons, so the
 * League AI can be questioned about pickups and trades and show its working.
 */
export function ollamaModelFor(settings: AiSettings, task: AiTask): string {
  const writing = settings.ollamaModel ?? DEFAULT_OLLAMA_MODEL;
  if (task === 'judgment') return settings.ollamaJudgmentModel ?? writing;
  if (task === 'chat') return settings.ollamaChatModel ?? writing;
  return writing;
}
