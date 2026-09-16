/**
 * A local model through Ollama's HTTP API.
 *
 * Free and private, and the model this project already had installed. It is
 * much slower than Claude — the reason it was taken off the decision path — but
 * for a few sentences, written only when asked, that is an acceptable trade.
 */

import { LlmError, type LlmProvider, type LlmRequest, type LlmText } from './types.js';

export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

/** A 14B model on a desktop GPU can take a while to load and answer. */
const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Ollama's default context window is small, and a longer prompt is cut off
 * without an error. The League AI brief plus a conversation needs more than
 * the default, so every request asks for at least this much.
 */
const DEFAULT_CONTEXT_TOKENS = 8_192;

interface OllamaChatResponse {
  readonly message?: { readonly content?: string };
}

interface OllamaTagsResponse {
  readonly models?: readonly { readonly name: string }[];
}

export class OllamaProvider implements LlmProvider {
  readonly id = 'ollama' as const;

  constructor(
    readonly model: string,
    private readonly baseUrl: string = DEFAULT_OLLAMA_URL,
    /** Injected so tests can run without a local server. */
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(request: LlmRequest): Promise<LlmText> {
    const body = {
      model: this.model,
      stream: false,
      messages: [
        { role: 'system', content: request.system },
        ...(request.history ?? []).map((turn) => ({ role: turn.role, content: turn.content })),
        { role: 'user', content: request.user },
      ],
      options: { temperature: 0.2, num_ctx: request.contextTokens ?? DEFAULT_CONTEXT_TOKENS },
    };
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Reasoning models such as DeepSeek-R1 think by default: slow, and pointless
    // for a few sentences of prose. Ask them not to. A model with no thinking
    // mode may reject the flag, so retry once without it.
    let res = await this.post({ ...body, think: false }, timeoutMs);
    if (res.status === 400) {
      const detail = await res.text();
      if (!/think/i.test(detail)) {
        throw new LlmError('bad-response', `Ollama rejected the request: ${detail.slice(0, 160)}`);
      }
      res = await this.post(body, timeoutMs);
    }
    if (res.status === 404) {
      throw new LlmError(
        'not-configured',
        `The model "${this.model}" is not installed in Ollama. Run: ollama pull ${this.model}`,
      );
    }
    if (!res.ok) throw new LlmError('bad-response', `Ollama returned HTTP ${res.status}.`);

    const data = (await res.json()) as OllamaChatResponse;
    const text = stripThinking(data.message?.content ?? '').trim();
    if (!text) throw new LlmError('bad-response', 'The local model returned no text.');
    return { text, provider: 'ollama', model: this.model };
  }

  private async post(body: unknown, timeoutMs: number): Promise<Response> {
    try {
      return await this.fetchImpl(`${trimSlash(this.baseUrl)}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw networkError(error, this.baseUrl, timeoutMs);
    }
  }
}

/** Models installed in a running Ollama, for the settings form. */
export async function listOllamaModels(
  baseUrl: string = DEFAULT_OLLAMA_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  let res: Response;
  try {
    res = await fetchImpl(`${trimSlash(baseUrl)}/api/tags`, { signal: AbortSignal.timeout(5_000) });
  } catch (error) {
    throw networkError(error, baseUrl, 5_000);
  }
  if (!res.ok) throw new LlmError('unavailable', `Ollama at ${baseUrl} returned HTTP ${res.status}.`);
  const data = (await res.json()) as OllamaTagsResponse;
  return (data.models ?? []).map((m) => m.name);
}

/** Older Ollama builds inline a reasoning model's thinking in the answer. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '');
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function networkError(error: unknown, baseUrl: string, timeoutMs: number): LlmError {
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new LlmError(
      'timeout',
      `The local model took longer than ${Math.round(timeoutMs / 1000)} seconds. Try again, or switch to Claude.`,
    );
  }
  return new LlmError(
    'unavailable',
    `Ollama is not answering at ${baseUrl}. Start Ollama, or turn AI explanations off.`,
  );
}
