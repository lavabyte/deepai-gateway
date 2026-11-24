/**
 * The context numbers this gateway publishes, and the line past which it shortens a prompt.
 *
 * There are two kinds of number here, and keeping them in one file is the point: the API, the
 * shortening and the log all read them from here, so they cannot drift apart.
 *
 * - The **declared** window is DeepAI's own `320000`, read from `/deepai_code/models`. The
 *   desktop app spreads that entry into its model config unchanged and compacts at
 *   `contextWindow - reserveTokens`, so it is what the catalog says a model can take.
 *
 * - The **measured** wall is about 196 KB, and it is on the part of the prompt the endpoint has
 *   to read **fresh** - not on the request body and not on the whole conversation. Measured on
 *   the live endpoint with a marker at each end of a cold prompt (no prompt cache for the
 *   session): English prose arrives whole at 195,809 bytes of body (40,194 prompt tokens) and is
 *   discarded at 196,811 (191 tokens reported, empty answer); Cyrillic, two bytes per character,
 *   arrives whole at 193,339 bytes (69,501 tokens) and is discarded at 197,280. Same cliff, same
 *   byte count, token counts 70% apart - so the limit is the size of what has to be read, not its
 *   token count.
 *
 * The same endpoint serves prompts of many megabytes once the conversation's prefix is in its
 * prompt cache: this gateway's own recorded traffic (`data/deepai.db`, table `usage`) has answers
 * with 720,896 cached prompt tokens and 155 fresh ones, and the desktop app's session store shows
 * 1.7 MB request bodies answered with 291,328 cached tokens and 424 fresh. The cache is addressed
 * by the session id (`session_id` / `x-session-affinity`), so the wall binds only on a cold
 * conversation or after a harness compaction changed the opening - which is why
 * `deepai/sessions.js` keeps the id but marks the prompt cold, and `deepai/fit.js` shortens it.
 *
 * And it is not a refusal: past the wall the endpoint answers from whatever it kept, usually the
 * tail, with a normal 200 (commits 2b9f7d8, 71ff762, 9bb3d1a, 503b69b record the measurements).
 * That is why the budget below is measured in bytes and on the fresh part only, and why a fresh
 * prompt over it is shortened here instead of being sent to be truncated.
 *
 * @module deepai-gateway/deepai/window
 */

/**
 * The window DeepAI's catalog declares, and the one published as `context_window`.
 *
 * It is the number a harness should compact against: the desktop app reads the same 320,000 out
 * of the same catalog and compacts at `contextWindow - reserveTokens`, about 290,000 tokens,
 * which is exactly where its observed compactions happen. A warm conversation of that size is
 * served, so a smaller published window would make clients compact for no reason.
 */
export const CONTEXT_WINDOW_TOKENS = 320_000;

/**
 * Characters per token, the density every estimate in this codebase is built on.
 *
 * It is the same meter that fills `prompt_tokens` when DeepAI sends no usage, so a client's
 * context gauge and this gateway's own estimates agree about how full a prompt is.
 */
export const CHARS_PER_TOKEN = 4;

/**
 * The declared window in characters.
 *
 * Reported as `budget` on `x-gateway-prompt` so a caller can see the window in the unit the
 * token meter counts in. It is not a guard: a prompt larger than this is served from the
 * endpoint's cache, which is the whole point of keeping the session warm.
 */
export const PROMPT_BUDGET_CHARS = CONTEXT_WINDOW_TOKENS * CHARS_PER_TOKEN;

/**
 * Where the endpoint stops reading a prompt it has to read fresh, in bytes, measured.
 *
 * 195,809 bytes arrived whole and 196,811 did not, on two alphabets with token counts 70% apart;
 * see the module comment. The figure is rounded down to 196,000 rather than used to the byte: it
 * is a cliff observed from one side, not a documented limit, and the budget below keeps well
 * clear of it anyway.
 */
export const PROMPT_WALL_BYTES = 196_000;

/**
 * The largest amount of prompt this gateway sends that the endpoint has to read fresh, in bytes.
 *
 * 176,400 is 90% of the measured wall - the same rule DeepAI Code applies to its own context,
 * compacting before the limit rather than after it. It is the threshold at which a request is
 * shortened before it is sent, and it is measured on the part of the prompt that is not already
 * cached:
 * the messages after the last one the conversation's stored tail covers, serialized as they would
 * be sent. On a cold conversation that is the whole serialized body, tools and framing included.
 * A conversation whose prefix is cached is forwarded however large it is; only its new tail is
 * counted.
 *
 * Overridable per deployment with `PROMPT_BUDGET_BYTES`; see `config()` in `server.js`.
 */
export const PROMPT_BUDGET_BYTES = 176_400;
