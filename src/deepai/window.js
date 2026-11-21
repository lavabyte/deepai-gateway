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
 * limit is a **byte** limit: about 196 KB of request body. It is applied to whole messages from
 * the front, so what a caller loses first is the beginning of the conversation.
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
 * What this gateway is willing to forward.
 *
 * Under the limit on purpose: the sentence the gateway adds when it shortens a conversation is
 * part of the prompt too, and a request cut to exactly the wall plus a note about the cut is over.
 */
export const PROMPT_BUDGET_BYTES = 170_000;

/**
 * The same wall in the unit every catalog speaks, for a client that counts tokens.
 *
 * English prose carries about 4.5 characters per token, so 196 KB is about 43,500 tokens. The
 * figure published is 40,000 - a floor that holds for prose of any flavour, and short of the
 * 100,000 tokens that pathological text can push through the same bytes. It is deliberately the
 * conservative end: a client that compacts a little early loses a little history to a summary,
 * and a client that compacts a little late loses the beginning of its conversation without
 * being told.
 */
export const SERVED_CONTEXT_TOKENS = 40_000;
