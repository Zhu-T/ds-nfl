import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { ClaudeProvider } from './claude.js';
import { LlmError } from './types.js';

/** A stand-in client that replays scripted responses and records each request. */
function scripted(responses: unknown[]) {
  const calls: any[] = [];
  const client = {
    messages: {
      create: async (params: unknown) => {
        calls.push(structuredClone(params));
        const next = responses.shift();
        if (!next) throw new Error('no more scripted responses');
        return next;
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const usage = (searches: number) => ({ input_tokens: 100, output_tokens: 50, server_tool_use: { web_search_requests: searches } });

const searchTurn = {
  stop_reason: 'pause_turn',
  model: 'claude-opus-5',
  usage: usage(2),
  content: [
    { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'Kyle Pitts injury' } },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srv_1',
      content: [
        { type: 'web_search_result', url: 'https://www.espn.com/pitts', title: 'Pitts update', encrypted_content: 'x', page_age: null },
        { type: 'web_search_result', url: 'https://www.nfl.com/pitts', title: 'Pitts news', encrypted_content: 'y', page_age: null },
      ],
    },
  ],
};

const finalTurn = {
  stop_reason: 'end_turn',
  model: 'claude-opus-5',
  usage: usage(1),
  content: [
    {
      type: 'text',
      text: 'Pitts was limited on Thursday.',
      citations: [{ type: 'web_search_result_location', url: 'https://www.cbssports.com/pitts', title: 'CBS', cited_text: '…', encrypted_index: 'z' }],
    },
    { type: 'text', text: '\n```json\n{"findings": []}\n```' },
  ],
};

describe('ClaudeProvider.research', () => {
  it('searches with the web search tool and resumes a paused turn', async () => {
    const { client, calls } = scripted([searchTurn, finalTurn]);
    const result = await new ClaudeProvider(client).research({ system: 'SYS', user: 'Q', maxSearches: 6 });

    expect(calls).toHaveLength(2);
    expect(calls[0].tools).toEqual([{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }]);
    expect(calls[0].system).toBe('SYS');
    // The paused assistant turn goes back unchanged, with no extra user message.
    expect(calls[1].messages).toEqual([
      { role: 'user', content: 'Q' },
      { role: 'assistant', content: searchTurn.content },
    ]);

    expect(result.text).toBe('Pitts was limited on Thursday.\n```json\n{"findings": []}\n```');
    expect(result.searches).toBe(3);
    expect(result.sources.map((s) => s.url).sort()).toEqual([
      'https://www.cbssports.com/pitts',
      'https://www.espn.com/pitts',
      'https://www.nfl.com/pitts',
    ]);
  });

  it('reports a refusal instead of an empty result', async () => {
    const { client } = scripted([{ ...finalTurn, stop_reason: 'refusal', content: [] }]);
    await expect(new ClaudeProvider(client).research({ system: 'S', user: 'Q' })).rejects.toMatchObject({ kind: 'refusal' });
  });

  it('gives up after a bounded number of paused rounds', async () => {
    const { client, calls } = scripted(Array.from({ length: 10 }, () => searchTurn));
    const error = await new ClaudeProvider(client).research({ system: 'S', user: 'Q' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).kind).toBe('timeout');
    expect(calls.length).toBeLessThan(10);
  });
});
