import { describe, it, expect } from 'vitest';
import { contextTokensFor, contextWindowFor, MAX_CONTEXT_TOKENS } from './ai-models';
import { DEFAULT_MAX_WINDOW_TOKENS, MIN_WINDOW_TOKENS } from '@ds-nfl/llm';

describe('contextTokensFor', () => {
  it('uses the saved window, and the default when there is none', () => {
    expect(contextTokensFor({ provider: 'ollama', ollamaContextTokens: 65_536 })).toBe(65_536);
    expect(contextTokensFor({ provider: 'ollama' })).toBe(DEFAULT_MAX_WINDOW_TOKENS);
  });

  it('holds a saved window to what is usable', () => {
    expect(contextTokensFor({ provider: 'ollama', ollamaContextTokens: 512 })).toBe(MIN_WINDOW_TOKENS);
    expect(contextTokensFor({ provider: 'ollama', ollamaContextTokens: 1_000_000 })).toBe(MAX_CONTEXT_TOKENS);
  });
});

describe('contextWindowFor', () => {
  it('leaves Claude alone: its window dwarfs anything the app sends', () => {
    expect(contextWindowFor({ provider: 'claude' })).toBeGreaterThan(MAX_CONTEXT_TOKENS);
  });
});
