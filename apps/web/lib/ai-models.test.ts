import { describe, it, expect } from 'vitest';
import { DEFAULT_OLLAMA_MODEL, ollamaModelFor } from './ai-models';

describe('ollamaModelFor', () => {
  it('uses one model for everything when no judgement model is saved, as stores saved before it do', () => {
    const saved = { provider: 'ollama' as const, ollamaModel: 'ds-nfl-lora:latest' };
    expect(ollamaModelFor(saved, 'writing')).toBe('ds-nfl-lora:latest');
    expect(ollamaModelFor(saved, 'judgment')).toBe('ds-nfl-lora:latest');
  });

  it('sends only judgement tasks to the judgement model', () => {
    const saved = { provider: 'ollama' as const, ollamaModel: 'ds-nfl-lora:latest', ollamaJudgmentModel: 'deepseek-r1:14b' };
    expect(ollamaModelFor(saved, 'writing')).toBe('ds-nfl-lora:latest');
    expect(ollamaModelFor(saved, 'judgment')).toBe('deepseek-r1:14b');
  });

  it('falls back to the default model when none is saved', () => {
    expect(ollamaModelFor({ provider: 'ollama' }, 'writing')).toBe(DEFAULT_OLLAMA_MODEL);
    expect(ollamaModelFor({ provider: 'ollama' }, 'judgment')).toBe(DEFAULT_OLLAMA_MODEL);
  });
});
