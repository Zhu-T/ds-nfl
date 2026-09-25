/**
 * How big a context window a local model needs for a prompt.
 *
 * Ollama refuses the whole request when the prompt is larger than the window
 * asked for — "request (16619 tokens) exceeds the available context size
 * (16384 tokens)" — so the estimate has to err upward. A window a little too
 * large costs some VRAM while the model runs; one a little too small loses the
 * answer entirely.
 *
 * Three characters per token was too generous for this app's prompts: they are
 * dense with names, decimals and ids, which tokenise closer to 2.5.
 */

/** Characters per token, chosen low so the estimate is never under the truth. */
export const CHARS_PER_TOKEN = 2.5;
/** Room kept for the model's own answer. */
export const DEFAULT_RESERVE_TOKENS = 1_024;
/** Ollama allocates in blocks; asking for a round number avoids surprises. */
export const WINDOW_STEP = 4_096;
/** Below this a window buys nothing: the prompt alone is bigger. */
export const MIN_WINDOW_TOKENS = 8_192;
/** What the app asks for at most unless the setting says otherwise. */
export const DEFAULT_MAX_WINDOW_TOKENS = 32_768;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Tokens in everything sent: system prompt, earlier turns, and the question. */
export function promptTokens(parts: readonly string[]): number {
  return parts.reduce((total, part) => total + estimateTokens(part), 0);
}

export interface WindowOptions {
  readonly reserve?: number;
  readonly max?: number;
}

/**
 * The window to ask for: the prompt, plus room to answer, rounded up to the
 * next block and held between the floor and the cap.
 */
export function windowFor(promptChars: number, opts: WindowOptions = {}): number {
  const reserve = opts.reserve ?? DEFAULT_RESERVE_TOKENS;
  const max = opts.max ?? DEFAULT_MAX_WINDOW_TOKENS;
  const needed = Math.ceil(promptChars / CHARS_PER_TOKEN) + reserve;
  const rounded = Math.ceil(needed / WINDOW_STEP) * WINDOW_STEP;
  return Math.min(Math.max(rounded, MIN_WINDOW_TOKENS), Math.max(max, MIN_WINDOW_TOKENS));
}

/** The window for a prompt given as its parts, so callers need not concatenate. */
export function windowForParts(parts: readonly string[], opts: WindowOptions = {}): number {
  return windowFor(parts.reduce((total, part) => total + part.length, 0), opts);
}

/**
 * The window a prompt of this many tokens needs, for retrying after the server
 * has told us exactly how big the prompt was.
 */
export function windowForTokens(tokens: number, opts: WindowOptions = {}): number {
  const reserve = opts.reserve ?? DEFAULT_RESERVE_TOKENS;
  const max = opts.max ?? DEFAULT_MAX_WINDOW_TOKENS;
  const rounded = Math.ceil((tokens + reserve) / WINDOW_STEP) * WINDOW_STEP;
  return Math.min(Math.max(rounded, MIN_WINDOW_TOKENS), Math.max(max, MIN_WINDOW_TOKENS));
}

/** Characters that fit in a window, leaving room for the answer. */
export function charBudget(window: number, opts: WindowOptions = {}): number {
  const reserve = opts.reserve ?? DEFAULT_RESERVE_TOKENS;
  return Math.max(0, Math.floor((window - reserve) * CHARS_PER_TOKEN));
}
