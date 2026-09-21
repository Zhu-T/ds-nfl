/**
 * Claude, through the official Anthropic SDK.
 *
 * Settings follow Anthropic's current guidance for this model:
 *   - Claude Opus 5, with adaptive thinking (on by default when `thinking` is
 *     omitted).
 *   - Low effort, because turning a short list of computed facts into a few
 *     sentences is a simple task — effort is the cost lever, not the model.
 *   - Server-side refusal fallback. If the model's safety classifier declines,
 *     the API re-runs the request on Anthropic's recommended fallback model in
 *     the same call instead of returning an empty answer.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  LlmError,
  type LlmProvider,
  type LlmRequest,
  type LlmText,
  type ResearchRequest,
  type ResearchResult,
  type ResearchSource,
} from './types.js';
import { normalizeUrl } from './research.js';

export const CLAUDE_MODEL = 'claude-opus-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const DEFAULT_TIMEOUT_MS = 60_000;
const RESEARCH_TIMEOUT_MS = 300_000;
/** Paused search turns resumed before giving up. */
const MAX_RESEARCH_ROUNDS = 4;

export class ClaudeProvider implements LlmProvider {
  readonly id = 'claude' as const;
  readonly model = CLAUDE_MODEL;

  constructor(private readonly client: Anthropic) {}

  async complete(request: LlmRequest): Promise<LlmText> {
    let response;
    try {
      response = await this.client.beta.messages.create(
        {
          model: CLAUDE_MODEL,
          max_tokens: 16000,
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
          output_config: { effort: 'low' },
          system: request.cacheSystem
            ? [{ type: 'text' as const, text: request.system, cache_control: { type: 'ephemeral' as const } }]
            : request.system,
          messages: [
            ...(request.history ?? []).map((turn) => ({ role: turn.role, content: turn.content })),
            { role: 'user' as const, content: request.user },
          ],
        },
        { timeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS },
      );
    } catch (error) {
      throw toLlmError(error);
    }

    // A refusal arrives as HTTP 200 with no usable content, so check first.
    if (response.stop_reason === 'refusal') {
      throw new LlmError(
        'refusal',
        'Claude declined to write this, and so did the fallback model. The recommendation itself is unaffected.',
      );
    }

    const text = response.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('')
      .trim();
    if (!text) throw new LlmError('bad-response', 'Claude returned no text.');

    // Adaptive thinking, when Claude shows it; kept for display, see LlmText.reasoning.
    const reasoning = response.content
      .flatMap((block) => (block.type === 'thinking' && block.thinking.trim() ? [block.thinking.trim()] : []))
      .join('\n\n');

    // With a fallback in play, the model that answered may not be the one asked.
    return { text, provider: 'claude', model: response.model, ...(reasoning ? { reasoning } : {}) };
  }

  /**
   * Research on the web with Anthropic's server-side search tool.
   *
   * Searches run on Anthropic's side within the request. When a turn reaches
   * the server's search-loop limit it comes back as `pause_turn`, and is resumed
   * by sending it back unchanged — no extra user message. Every page the
   * searches returned is collected so the caller can reject any finding that
   * cites a page Claude never actually retrieved.
   */
  async research(request: ResearchRequest): Promise<ResearchResult> {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: request.user }];
    const sources = new Map<string, ResearchSource>();
    let searches = 0;

    for (let round = 0; round < MAX_RESEARCH_ROUNDS; round++) {
      let response: Anthropic.Message;
      try {
        response = await this.client.messages.create(
          {
            model: CLAUDE_MODEL,
            max_tokens: 16000,
            thinking: { type: 'adaptive' },
            output_config: { effort: 'medium' },
            system: request.system,
            tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: request.maxSearches ?? 8 }],
            messages,
          },
          { timeout: request.timeoutMs ?? RESEARCH_TIMEOUT_MS },
        );
      } catch (error) {
        throw toLlmError(error);
      }

      searches += response.usage?.server_tool_use?.web_search_requests ?? 0;
      collectSources(response.content, sources);

      if (response.stop_reason === 'refusal') {
        throw new LlmError('refusal', 'Claude declined to research this. Nothing was changed.');
      }
      if (response.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: response.content });
        continue;
      }

      const text = response.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('')
        .trim();
      if (!text) throw new LlmError('bad-response', 'Claude finished searching without writing a report.');
      return { text, sources: [...sources.values()], searches, provider: 'claude', model: response.model };
    }

    throw new LlmError(
      'timeout',
      'Claude was still searching after several rounds. Try again, or check fewer players.',
    );
  }
}

/**
 * Every page a search returned or a citation points at, keyed by normalized URL.
 *
 * The walk is structural rather than tied to one block type: with dynamic
 * filtering, results can reach the answer through nested tool results, and a
 * page that was genuinely retrieved should count however it arrived. The
 * model's own prose is never scanned, so a URL it merely writes does not count.
 */
export function collectSources(content: readonly unknown[], into: Map<string, ResearchSource>): void {
  const visit = (node: unknown, depth: number): void => {
    if (depth > 8 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    const url = obj['url'];
    if (typeof url === 'string' && /^https?:[/][/]/i.test(url)) {
      const key = normalizeUrl(url);
      // Search results state the page's age; kept so old pages can be refused.
      const pageAge = typeof obj['page_age'] === 'string' && obj['page_age'] ? obj['page_age'] : undefined;
      const seen = into.get(key);
      if (!seen) {
        const title = typeof obj['title'] === 'string' && obj['title'] ? obj['title'] : url;
        into.set(key, { url, title, ...(pageAge ? { published: pageAge } : {}) });
      } else if (pageAge && !seen.published) {
        // A citation can come before its search result; the result's age still counts.
        into.set(key, { ...seen, published: pageAge });
      }
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key !== 'text' && key !== 'input') visit(value, depth + 1);
    }
  };
  for (const block of content) {
    const type = (block as { type?: unknown })?.type;
    if (type === 'thinking' || type === 'redacted_thinking') continue;
    visit(block, 0);
  }
}

/** Map SDK errors, most specific first, to messages a user can act on. */
export function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  if (error instanceof Anthropic.AuthenticationError) {
    return new LlmError('auth', 'Anthropic rejected the API key. Check it on the Connect page.');
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new LlmError('rate-limit', 'Anthropic is rate-limiting this key. Try again in a moment.');
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new LlmError('timeout', 'Claude did not answer in time. Try again.');
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new LlmError('unavailable', 'Could not reach the Anthropic API. Check the internet connection.');
  }
  if (error instanceof Anthropic.APIError) {
    return new LlmError('bad-response', `The Anthropic API returned an error: ${error.message}`);
  }
  return new LlmError('bad-response', error instanceof Error ? error.message : String(error));
}

export function createClaudeProvider(apiKey?: string): ClaudeProvider {
  try {
    // With no stored key the SDK falls back to ANTHROPIC_API_KEY or an
    // `ant auth` profile on its own.
    return new ClaudeProvider(
      new Anthropic({ ...(apiKey ? { apiKey } : {}), timeout: DEFAULT_TIMEOUT_MS, maxRetries: 1 }),
    );
  } catch {
    throw new LlmError('not-configured', 'No Anthropic API key is set. Add one on the Connect page.');
  }
}

/** Confirm a key works without spending tokens: listing models is free. */
export async function verifyClaudeKey(apiKey: string): Promise<void> {
  try {
    await new Anthropic({ apiKey, timeout: 15_000, maxRetries: 0 }).models.list();
  } catch (error) {
    throw toLlmError(error);
  }
}
