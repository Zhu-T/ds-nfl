/**
 * The contract for the optional language-model layer.
 *
 * The model's job is narrow on purpose: it turns numbers the engine has already
 * computed into prose. It never chooses a lineup, never values a trade, and
 * never touches the platform. The previous version of this project let a local
 * model make every decision on a 30-second draft clock; it lost, and ESPN's
 * Autodraft picked instead. Keeping the model out of the decision path is what
 * makes it safe to switch providers, or turn the layer off, without changing a
 * single recommendation.
 */

export type ProviderId = 'claude' | 'ollama';

/** One earlier turn of a conversation. */
export interface ChatTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface LlmRequest {
  /** Stable instructions for the task. */
  readonly system: string;
  /** The facts and the ask for this one request. */
  readonly user: string;
  /** Earlier turns of a conversation, oldest first. */
  readonly history?: readonly ChatTurn[];
  /**
   * Mark the system prompt for prompt caching. The league assistant resends a
   * large, unchanging brief on every turn, which is what caching is for.
   * Ollama ignores it.
   */
  readonly cacheSystem?: boolean;
  /**
   * Context window the request needs, in tokens. Ollama silently cuts prompts
   * longer than its window, which defaults small. Claude ignores it.
   */
  readonly contextTokens?: number;
  readonly timeoutMs?: number;
}

export interface LlmText {
  readonly text: string;
  readonly provider: ProviderId;
  /** The model that actually produced the text, for attribution in the UI. */
  readonly model: string;
}

/** A page a web search returned. */
export interface ResearchSource {
  readonly url: string;
  readonly title: string;
  /** The player the app gathered this item for; a finding may only cite its own player's items. */
  readonly about?: string;
  /** When the source says it was published: a date, or a search result's age such as "3 days ago". */
  readonly published?: string;
}

export interface ResearchRequest {
  readonly system: string;
  readonly user: string;
  /** Upper bound on web searches for this request; each one is billed. */
  readonly maxSearches?: number;
  readonly timeoutMs?: number;
}

export interface ResearchResult {
  /** The model's final answer. */
  readonly text: string;
  /** Every page the searches returned or the answer cited. */
  readonly sources: readonly ResearchSource[];
  /** Web searches actually run, for the cost shown in the UI. */
  readonly searches: number;
  readonly provider: ProviderId;
  readonly model: string;
}

export type LlmErrorKind =
  | 'not-configured'
  | 'auth'
  | 'rate-limit'
  | 'refusal'
  | 'timeout'
  | 'unavailable'
  | 'bad-response';

/** Every failure carries a message written for the person using the app. */
export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface LlmProvider {
  readonly id: ProviderId;
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmText>;
  /** Present only for providers that can search the web; Claude can, Ollama cannot. */
  research?(request: ResearchRequest): Promise<ResearchResult>;
}
