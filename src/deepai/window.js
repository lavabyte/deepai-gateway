/**
 * How much prompt this endpoint physically takes, and how much it claims to take.
 *
 * The catalog's `contextWindow` is a claim made by DeepAI and repeated by everyone downstream:
 * the desktop app reads it out of `/deepai_code/models`, spreads it into its model config
 * unchanged, and compacts at `contextWindow - reserveTokens`. Nothing in that chain measures
 * anything, and nothing in it can be corrected, because an oversized prompt is not refused - it
 * comes back as a normal 200 answered from what was left.
 *
 * So the wall was measured here instead, twice, with a marker at the start of a prompt and a
 * marker at the end and a request to repeat both:
 *
 * | body       | alphabet   | prompt tokens reported | result                  |
 * | ---------- | ---------- | ---------------------- | ----------------------- |
 * | 195,809 B  | English    | 40,194                 | read whole              |
 * | 196,811 B  | English    | 191                    | discarded, empty answer |
 * | 193,339 B  | Cyrillic   | 69,501                 | read whole              |
 * | 197,280 B  | Cyrillic   | 191                    | discarded               |
 *
 * Same cliff at the same number of bytes while the token counts differ by 70%, which is why the
 * limit is a **byte** limit: about 196 KB of request body. The endpoint applies it by dropping
 * whole messages from the front, so what a caller loses first is the beginning of the
 * conversation - and nothing in the answer says so.
 *
 * An earlier pass over this ground used random words, which tokenize at about 1.5 characters per
 * token, and so saw the same cliff at 162,000 characters. Reading that as a character limit was
 * wrong; reading it as a token limit would be wronger still - 320,000 tokens of English prose is
 * roughly 1.3 MB of body, six times over the wall.
 *
 * @module deepai-gateway/deepai/window
 */

/** Where the endpoint stops reading: measured between 195,809 and 196,811 bytes of body. */
export const PROMPT_LIMIT_BYTES = 196_000;

/**
 * What this gateway accepts, and the number its refusal names.
 *
 * 90% of the wall, which is the same rule DeepAI Code applies to its own context: compact before
 * you are at the limit, not after. A client that compacts at 90% of `SERVED_CONTEXT_TOKENS` stays
 * under it, and the JSON framing around the messages - JSON overhead, the tools array - which
 * `promptShape` does not count, has the remaining tenth as room of its own.
 *
 * This gateway does not shorten a prompt to fit. It refuses a conversation over the budget with
 * `context_length_exceeded` and lets the caller compact: this endpoint is pointed at by other
 * coding agents, and their compaction is done with the whole conversation in front of them, which
 * a proxy's copy is not.
 */
export const PROMPT_BUDGET_BYTES = Math.round(PROMPT_LIMIT_BYTES * 0.9);

/**
 * The same wall in the unit every catalog speaks, and the window advertised to clients.
 *
 * English prose carries about 4.5 characters per token, so 196 KB is about 43,500 tokens. The
 * figure published is 40,000, and the arithmetic of the two numbers is the point: 90% of 40,000
 * tokens is 36,000, which at the ~4.9 bytes per token that prose measured at (195,809 B came back
 * as 40,194 tokens) is 176,400 bytes - exactly the budget above. A harness that compacts at the
 * same 90% the desktop app uses therefore lands on the line this gateway accepts, rather than on
 * a number that looks safe and is not. It is a floor for prose of any flavour and short of the
 * 100,000 tokens pathological text can push through the same bytes, so it errs towards compacting
 * early - which costs a summary, not the start of a conversation.
 *
 * This is the number `/v1/models` publishes as `context_window`, because it is the one a harness
 * has to compact against; DeepAI's catalog claim (320,000) is published beside it as
 * `context_window_claimed`, and a client that compacts at 90% of that loses the start of its
 * conversation without being told.
 */
export const SERVED_CONTEXT_TOKENS = 40_000;
