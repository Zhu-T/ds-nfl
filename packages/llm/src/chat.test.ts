import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { ClaudeProvider, CLAUDE_MODEL } from './claude.js';
import { OllamaProvider } from './ollama.js';
import { leagueChatRequest } from './prompts.js';

const history = [
  { role: 'user' as const, content: 'Why is Wilson on the bench?' },
  { role: 'assistant' as const, content: 'He projects 8.3.' },
];

describe('leagueChatRequest', () => {
  it('puts the whole league context in the system prompt and marks it cacheable', () => {
    const req = leagueChatRequest("Tony's Personal Computer", 'CONTEXT BODY', history, 'And now?');
    expect(req.system).toContain("manager of Tony's Personal Computer");
    expect(req.system).toContain('CONTEXT BODY');
    expect(req.cacheSystem).toBe(true);
    expect(req.history).toEqual(history);
    expect(req.user).toBe('And now?');
  });

  it("sizes the local model's context window to fit the brief and the conversation", () => {
    expect(leagueChatRequest('T', 'short', [], 'Q?').contextTokens).toBe(8_192);
    const big = leagueChatRequest('T', 'x'.repeat(60_000), history, 'Q?').contextTokens!;
    expect(big).toBeGreaterThan(60_000 / 3);
    expect(big % 4_096).toBe(0);
    expect(leagueChatRequest('T', 'x'.repeat(500_000), history, 'Q?').contextTokens).toBe(32_768);
  });
});

describe('providers carry the conversation', () => {
  it('Claude sends earlier turns before the new question, with the system prompt cached', async () => {
    const sent: any[] = [];
    const client = {
      beta: {
        messages: {
          create: async (params: unknown) => {
            sent.push(params);
            return { stop_reason: 'end_turn', model: CLAUDE_MODEL, content: [{ type: 'text', text: 'ok' }] };
          },
        },
      },
    } as unknown as Anthropic;

    await new ClaudeProvider(client).complete({ system: 'SYS', user: 'Q', history, cacheSystem: true });

    expect(sent[0].system).toEqual([{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]);
    expect(sent[0].messages).toEqual([...history, { role: 'user', content: 'Q' }]);
  });

  it('Ollama sends system, then earlier turns, then the new question', async () => {
    const bodies: any[] = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ message: { content: 'ok' } }), { status: 200 });
    }) as typeof fetch;

    await new OllamaProvider('deepseek-r1:14b', undefined, fetchImpl).complete({ system: 'SYS', user: 'Q', history });

    expect(bodies[0].messages).toEqual([
      { role: 'system', content: 'SYS' },
      ...history,
      { role: 'user', content: 'Q' },
    ]);
  });
});
