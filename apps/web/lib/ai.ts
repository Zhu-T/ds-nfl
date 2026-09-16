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

/** The model this machine already had installed for the previous version. */
export const DEFAULT_OLLAMA_MODEL = 'deepseek-r1:14b';

export interface AiStatus {
  readonly provider: 'off' | 'claude' | 'ollama';
  /** Label for buttons and attribution; null when off. */
  readonly label: string | null;
  readonly anthropicKeySet: boolean;
  readonly ollamaUrl: string;
  readonly ollamaModel: string;
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
    ollamaSearchKeySet: Boolean(s.ollamaApiKey),
  };
}

/** Null when the AI layer is off. Throws an LlmError when it is on but unusable. */
export function currentProvider(): LlmProvider | null {
  const s = aiSettings();
  if (s.provider === 'claude') return createClaudeProvider(s.anthropicApiKey);
  if (s.provider === 'ollama') {
    return new OllamaProvider(s.ollamaModel ?? DEFAULT_OLLAMA_MODEL, s.ollamaUrl ?? DEFAULT_OLLAMA_URL);
  }
  return null;
}
