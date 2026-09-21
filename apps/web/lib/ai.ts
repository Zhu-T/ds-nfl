/**
 * Which language model, if any, writes explanations — read from local settings.
 *
 * The AI layer is optional in the strongest sense: with it off, every
 * recommendation, number, and action in the app is identical. Only the prose
 * disappears.
 */

import 'server-only';
import { readStore, type AiSettings } from '@ds-nfl/adapters';
import {
  CLAUDE_MODEL,
  DEFAULT_OLLAMA_URL,
  OllamaProvider,
  createClaudeProvider,
  type LlmProvider,
} from '@ds-nfl/llm';

import { DEFAULT_OLLAMA_MODEL, ollamaModelFor, type AiTask } from './ai-models';

export { DEFAULT_OLLAMA_MODEL, type AiTask };

export interface AiStatus {
  readonly provider: 'off' | 'claude' | 'ollama';
  /** Label for buttons and attribution; null when off. */
  readonly label: string | null;
  readonly anthropicKeySet: boolean;
  readonly ollamaUrl: string;
  readonly ollamaModel: string;
  /** The model for background judgement tasks; null when it is the same as `ollamaModel`. */
  readonly ollamaJudgmentModel: string | null;
  /** Label for the panels that run judgement tasks: the news check, waiver picks, and news reads. */
  readonly judgmentLabel: string | null;
  /** The model for the League AI chat; null when it is the same as `ollamaModel`. */
  readonly ollamaChatModel: string | null;
  /** Label for the League AI chat. */
  readonly chatLabel: string | null;
  /** Whether an Ollama web search key is stored. Never the key itself. */
  readonly ollamaSearchKeySet: boolean;
}

export function aiSettings(): AiSettings {
  return readStore().ai ?? { provider: 'off' };
}

/** Safe to send to the browser: says whether a key is stored, never what it is. */
export function aiStatus(): AiStatus {
  const s = aiSettings();
  const ollamaModel = s.ollamaModel ?? DEFAULT_OLLAMA_MODEL;
  return {
    provider: s.provider,
    label:
      s.provider === 'claude'
        ? `Claude (${CLAUDE_MODEL})`
        : s.provider === 'ollama'
          ? `${ollamaModel} (local)`
          : null,
    anthropicKeySet: Boolean(s.anthropicApiKey),
    ollamaUrl: s.ollamaUrl ?? DEFAULT_OLLAMA_URL,
    ollamaModel,
    ollamaJudgmentModel: s.ollamaJudgmentModel ?? null,
    judgmentLabel:
      s.provider === 'claude'
        ? `Claude (${CLAUDE_MODEL})`
        : s.provider === 'ollama'
          ? `${ollamaModelFor(s, 'judgment')} (local)`
          : null,
    ollamaChatModel: s.ollamaChatModel ?? null,
    chatLabel:
      s.provider === 'claude'
        ? `Claude (${CLAUDE_MODEL})`
        : s.provider === 'ollama'
          ? `${ollamaModelFor(s, 'chat')} (local)`
          : null,
    ollamaSearchKeySet: Boolean(s.ollamaApiKey),
  };
}

/**
 * Null when the AI layer is off. Throws an LlmError when it is on but unusable.
 * `task` picks the Ollama model: judgement tasks may use a separate one.
 */
export function currentProvider(task: AiTask = 'writing'): LlmProvider | null {
  const s = aiSettings();
  if (s.provider === 'claude') return createClaudeProvider(s.anthropicApiKey);
  if (s.provider === 'ollama') {
    return new OllamaProvider(ollamaModelFor(s, task), s.ollamaUrl ?? DEFAULT_OLLAMA_URL);
  }
  return null;
}
