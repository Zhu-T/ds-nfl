import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { ClaudeProvider, CLAUDE_MODEL, toLlmError } from './claude.js';
import { OllamaProvider, listOllamaModels, stripThinking } from './ollama.js';
import { LlmError } from './types.js';

const request = { system: 'SYSTEM', user: 'USER' };

/** A stand-in for the SDK client exposing only the call the provider makes. */
function fakeClaude(reply: Record<string, unknown>, sink: unknown[] = []): Anthropic {
  return {
    beta: {
      messages: {
        create: async (params: unknown) => {
          sink.push(params);
          return reply;
        },
      },
    },
  } as unknown as Anthropic;
}

describe('ClaudeProvider', () => {
  it('asks Opus 5 at low effort, with the server-side refusal fallback on', async () => {
    const sent: any[] = [];
    const provider = new ClaudeProvider(
      fakeClaude({ stop_reason: 'end_turn', model: CLAUDE_MODEL, content: [{ type: 'text', text: 'ok' }] }, sent),
    );
    await provider.complete(request);

    expect(sent[0].model).toBe('claude-opus-5');
    expect(sent[0].output_config).toEqual({ effort: 'low' });
    expect(sent[0].betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(sent[0].fallbacks).toBe('default');
    expect(sent[0].system).toBe('SYSTEM');
    expect(sent[0].messages).toEqual([{ role: 'user', content: 'USER' }]);
  });

  it('returns only the text blocks, skipping thinking', async () => {
    const provider = new ClaudeProvider(
      fakeClaude({
        stop_reason: 'end_turn',
        model: CLAUDE_MODEL,
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'text', text: 'Start Wilson. ' },
          { type: 'text', text: 'Bench Samuel.' },
        ],
      }),
    );
    expect((await provider.complete(request)).text).toBe('Start Wilson. Bench Samuel.');
  });

  it('attributes the text to the model that actually answered', async () => {
    // After a refusal fallback the response names the fallback model.
    const provider = new ClaudeProvider(
      fakeClaude({ stop_reason: 'end_turn', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'ok' }] }),
    );
    expect((await provider.complete(request)).model).toBe('claude-opus-4-8');
  });

  it('treats a refusal as an error rather than an empty explanation', async () => {
    const provider = new ClaudeProvider(fakeClaude({ stop_reason: 'refusal', model: CLAUDE_MODEL, content: [] }));
    await expect(provider.complete(request)).rejects.toMatchObject({ kind: 'refusal' });
  });

  it('maps SDK errors to messages a user can act on', () => {
    expect(toLlmError(Object.create(Anthropic.AuthenticationError.prototype)).kind).toBe('auth');
    expect(toLlmError(Object.create(Anthropic.RateLimitError.prototype)).kind).toBe('rate-limit');
    expect(toLlmError(Object.create(Anthropic.APIConnectionTimeoutError.prototype)).kind).toBe('timeout');
    expect(toLlmError(Object.create(Anthropic.APIConnectionError.prototype)).kind).toBe('unavailable');
  });
});

/** Records every request and replays scripted responses in order. */
function fakeFetch(responses: Response[], sink: { url: string; body: any }[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    sink.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
    const next = responses.shift();
    if (!next) throw new Error('no scripted response left');
    return next;
  }) as typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('OllamaProvider', () => {
  it('posts a non-streaming chat with thinking turned off', async () => {
    const sent: { url: string; body: any }[] = [];
    const provider = new OllamaProvider(
      'deepseek-r1:14b',
      'http://localhost:11434/',
      fakeFetch([json({ message: { content: 'Start Wilson.' } })], sent),
    );

    const out = await provider.complete(request);
    expect(out).toEqual({ text: 'Start Wilson.', provider: 'ollama', model: 'deepseek-r1:14b' });
    expect(sent[0]?.url).toBe('http://localhost:11434/api/chat');
    expect(sent[0]?.body).toMatchObject({
      model: 'deepseek-r1:14b',
      stream: false,
      think: false,
      messages: [
        { role: 'system', content: 'SYSTEM' },
        { role: 'user', content: 'USER' },
      ],
    });
  });

  it('retries without the think flag when a model rejects it', async () => {
    const sent: { url: string; body: any }[] = [];
    const provider = new OllamaProvider(
      'llama3',
      undefined,
      fakeFetch(
        [
          new Response('{"error":"\\"llama3\\" does not support thinking"}', { status: 400 }),
          json({ message: { content: 'ok' } }),
        ],
        sent,
      ),
    );
    expect((await provider.complete(request)).text).toBe('ok');
    expect(sent).toHaveLength(2);
    expect(sent[1]?.body).not.toHaveProperty('think');
  });

  it('removes inlined reasoning from older builds', async () => {
    const provider = new OllamaProvider(
      'deepseek-r1:14b',
      undefined,
      fakeFetch([json({ message: { content: '<think>weighing it up</think>\nStart Wilson.' } })]),
    );
    expect((await provider.complete(request)).text).toBe('Start Wilson.');
  });

  it('says how to install a missing model', async () => {
    const provider = new OllamaProvider('qwen3', undefined, fakeFetch([json({ error: 'model not found' }, 404)]));
    await expect(provider.complete(request)).rejects.toThrow(/ollama pull qwen3/);
  });

  it('explains a stopped Ollama instead of surfacing a raw network error', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const provider = new OllamaProvider('deepseek-r1:14b', undefined, down);
    const error = await provider.complete(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).kind).toBe('unavailable');
    expect((error as LlmError).message).toMatch(/not answering/);
  });
});

describe('Ollama helpers', () => {
  it('lists installed models', async () => {
    const models = await listOllamaModels(
      'http://localhost:11434',
      fakeFetch([json({ models: [{ name: 'deepseek-r1:14b' }, { name: 'llama3:8b' }] })]),
    );
    expect(models).toEqual(['deepseek-r1:14b', 'llama3:8b']);
  });

  it('strips every thinking block', () => {
    expect(stripThinking('<think>a</think>x<THINK>b</THINK>y')).toBe('xy');
  });
});
