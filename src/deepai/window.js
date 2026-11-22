/**
 * The context window this gateway publishes, and the one it refuses past.
 *
 * `320000` is DeepAI's own number, read from `/deepai_code/models`, and the one the desktop app
 * uses unchanged: it spreads the catalog entry into its model config and compacts at
 * `contextWindow - reserveTokens`. A client of this gateway that reads `/v1/models` and applies the
 * same rule behaves exactly like the app, which is the point of publishing it rather than a smaller
 * number invented here.
 *
 * An earlier revision published the result of measuring request bodies instead - 196,000 bytes of
 * body, about 40,000 tokens of prose - and refused anything larger. That measurement is not the
 * model's window: the same body size answered from the whole prompt in one run and from a fraction
 * of it in the next, depending on what the text was, and on some content it reported a few thousand
 * prompt tokens for a 200 KB body. It is recorded in the README as an observation. It is not a
 * policy, and it is not enforced here: the endpoint's window is the endpoint's to enforce.
 *
 * @module deepai-gateway/deepai/window
 */

/** The window DeepAI's catalog declares, and the one this gateway publishes and enforces. */
export const CONTEXT_WINDOW_TOKENS = 320_000;

/**
 * Characters per token, the density every estimate in this codebase is built on.
 *
 * It is the same meter that fills `prompt_tokens` when DeepAI sends no usage, so a client's
 * context gauge and this gateway's refusal agree about how full a prompt is.
 */
export const CHARS_PER_TOKEN = 4;

/** The prompt budget in characters: the window, in the unit that meter counts in. */
export const PROMPT_BUDGET_CHARS = CONTEXT_WINDOW_TOKENS * CHARS_PER_TOKEN;
