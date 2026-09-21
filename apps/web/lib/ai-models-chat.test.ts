import { describe, it, expect } from 'vitest';
import { ollamaModelFor } from './ai-models';

describe('the chat model', () => {
  it('is the main model unless one is saved for chat', () => {
    expect(ollamaModelFor({ provider: 'ollama', ollamaModel: 'ds-nfl-lora:latest' }, 'chat')).toBe('ds-nfl-lora:latest');
    const saved = { provider: 'ollama' as const, ollamaModel: 'ds-nfl-lora:latest', ollamaChatModel: 'deepseek-r1:14b' };
    expect(ollamaModelFor(saved, 'chat')).toBe('deepseek-r1:14b');
    expect(ollamaModelFor(saved, 'writing')).toBe('ds-nfl-lora:latest');
    expect(ollamaModelFor(saved, 'judgment')).toBe('ds-nfl-lora:latest');
  });
});
