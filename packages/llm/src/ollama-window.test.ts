import { describe, it, expect } from 'vitest';
import { OllamaProvider, tooLongFor } from './ollama.js';

/** The body Ollama sent back when the League AI outgrew its window. */
const REFUSAL = JSON.stringify({
  error: {
    code: 400,
    message: 'request (16619 tokens) exceeds the available context size (16384 tokens), try increasing it',
    type: 'exceed_context_error',
  },
});

function stub(replies: readonly Response[]) {
  const bodies: any[] = [];
  let call = 0;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return replies[Math.min(call++, replies.length - 1)]!;
  }) as typeof fetch;
  return { bodies, fetchImpl };
}

const ok = () => new Response(JSON.stringify({ message: { content: 'ok' } }), { status: 200 });
const refused = () => new Response(REFUSAL, { status: 400 });

describe('tooLongFor', () => {
  it('reads how big the prompt was and how big the window is', () => {
    expect(tooLongFor(REFUSAL)).toEqual({ needed: 16_619, available: 16_384 });
    expect(tooLongFor('something else entirely')).toBeNull();
  });
});

describe('OllamaProvider and the context window', () => {
  it('asks again with a window that holds the prompt, rather than losing the answer', async () => {
    const { bodies, fetchImpl } = stub([refused(), ok()]);
    const out = await new OllamaProvider('ds-nfl-lora:latest', undefined, fetchImpl).complete({
      system: 'S',
      user: 'Q',
      contextTokens: 16_384,
    });
    expect(out.text).toBe('ok');
    expect(bodies[0].options.num_ctx).toBe(16_384);
    // 16,619 plus room to answer, rounded up to a whole block.
    expect(bodies[1].options.num_ctx).toBe(20_480);
  });

  it('says what to change when even the cap cannot hold it', async () => {
    const { fetchImpl } = stub([refused()]);
    await expect(
      new OllamaProvider('ds-nfl-lora:latest', undefined, fetchImpl, 16_384).complete({ system: 'S', user: 'Q' }),
    ).rejects.toThrow(/more than ds-nfl-lora:latest is allowed here \(16384\).*Settings/s);
  });

  it('still retries a model that rejects the think flag, and still fails on anything else', async () => {
    const thinking = new Response('unknown field "think"', { status: 400 });
    const { bodies, fetchImpl } = stub([thinking, ok()]);
    expect((await new OllamaProvider('llama3', undefined, fetchImpl).complete({ system: 'S', user: 'Q' })).text).toBe('ok');
    expect(bodies[0].think).toBe(false);
    expect(bodies[1].think).toBeUndefined();

    const { fetchImpl: bad } = stub([new Response('model is loading', { status: 400 })]);
    await expect(new OllamaProvider('llama3', undefined, bad).complete({ system: 'S', user: 'Q' })).rejects.toThrow(
      /Ollama rejected the request/,
    );
  });
});
