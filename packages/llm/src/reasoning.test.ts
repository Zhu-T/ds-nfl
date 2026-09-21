import { describe, it, expect } from 'vitest';
import { OllamaProvider } from './ollama.js';

const answering = (message: Record<string, string>) =>
  (async () => new Response(JSON.stringify({ message }))) as unknown as typeof fetch;

const ask = { system: 'S', user: 'Should I add him?' };

describe("a local model's reasoning", () => {
  it('keeps the reasoning Ollama returns separately, out of the answer', async () => {
    const out = await new OllamaProvider('deepseek-r1:14b', 'http://x', answering({ content: 'No.', thinking: 'He would sit.' })).complete(ask);
    expect(out.text).toBe('No.');
    expect(out.reasoning).toBe('He would sit.');
  });

  it('keeps reasoning an older Ollama inlines in <think> tags, and strips it from the answer', async () => {
    const out = await new OllamaProvider('m', 'http://x', answering({ content: '<think>Bench is deep.</think>\nNo.' })).complete(ask);
    expect(out.text).toBe('No.');
    expect(out.reasoning).toBe('Bench is deep.');
  });

  it('has none for a model that does not reason', async () => {
    const out = await new OllamaProvider('ds-nfl-lora', 'http://x', answering({ content: 'No.' })).complete(ask);
    expect(out.reasoning).toBeUndefined();
  });
});
