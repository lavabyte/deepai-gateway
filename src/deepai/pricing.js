/**
 * What a paid model actually costs, measured rather than read out of the catalog.
 *
 * The catalog says `theosPerRequest` - about 2 for MiniMax M3, about 50 for GPT-6 Astra - and the
 * desktop app prints it in the same shape, with the note that "actual charges depend on token
 * usage". They do, and by a factor nobody would guess: a real request on MiniMax M3 cost
 * **0.0082 Credits**, not 2, and the most expensive model measured here costs 0.87 Credits per
 * 1,000 prompt tokens, which is 0.87 for a small request rather than the 20 its catalog row
 * claims. In this file a Credit is the account's balance unit, one for one; DeepAI calls the same
 * number a Theos, and that name stops at this module.
 *
 * Nothing in the payload carries the real price: `usage` has token counts and no cost, and the
 * response headers say nothing. What is left is the balance, `GET /deepai_code/theos`, read
 * before and after a request - which is how every number below was obtained, on one account, with
 * the gateway's own headers (lane 7, beacon `v=0.3.40`, check-in), against the live endpoint.
 *
 * Method, because the numbers only mean something with it:
 *
 *   - each model was sent a prompt it had never seen (about 9,600 tokens of text, different for
 *     every call). Repeating the same prompt measures the cache, not the price: ten identical
 *     requests billed half of what one fresh prompt did.
 *   - the balance moves in batches, so a single read after a small request can catch the previous
 *     request's charge or none at all. Deltas below about 0.05 Credits were therefore measured
 *     again and the values here are the consistent ones.
 *   - completion tokens cost four times a prompt token. Measured directly: on MiniMax M3 a
 *     request of 201 prompt and 900 completion tokens cost 0.12030, and one of 29,282 and 20 cost
 *     0.92931 - the only pair of rates that fits both is 31.7 per million prompt tokens and 126.7
 *     per million completion tokens. So the rate below is per million *weighted* tokens, where a
 *     completion token weighs four.
 *
 * What this is not: a price list. It is one account's measurement of one endpoint on one day, it
 * carries a few tens of percent of uncertainty on the cheap models, and DeepAI can change it
 * without telling anyone. It is here because "2 per request" is wrong by two orders of
 * magnitude, and a measured number that is roughly right is worth more than a catalog number that
 * is exactly wrong.
 *
 * @module deepai-gateway/deepai/pricing
 */

/**
 * Measured Credits per million weighted tokens, by model id.
 *
 * Weighted means `prompt + 4 * completion`: the completion rate was measured to be four times the
 * prompt rate, so one million weighted tokens cost the same whichever side they came from.
 */
export const MEASURED_THEOS_PER_MILLION = Object.freeze({
  'minimax-m3': 31.7,
  'glm-5.3': 9.0,
  'kimi-k3': 28.0,
  'kimi-k3.1-pro': 217.0,
  'gpt-6.1-terra': 103.0,
  'muse-spark-1.3': 129.0,
  'gemini-4-hydrogen': 163.0,
  'gemini-4-carbon': 216.0,
  'gpt-6.1-sol': 217.0,
  'gemini-4-argon': 216.0,
  'claude-sonnet-5-5': 206.0,
  'claude-opus-5-5': 435.0,
  'muse-wonder': 435.0,
  'qwen-3.8-max-prime': 395.0,
  'claude-fable-5-2': 869.0,
});

/** How much one completion token costs relative to one prompt token, as measured. */
export const COMPLETION_WEIGHT = 4;

/**
 * The measured rate for a model, or `null` when it was never measured.
 *
 * `null` rather than a guess: a caller that shows the catalog figure instead is showing something
 * labelled as what it is, and a caller that shows nothing is showing nothing - both are honest.
 * An invented rate would not be.
 *
 * @param {string} modelId
 * @returns {number|null} Credits per million weighted tokens.
 */
export function theosPerMillion(modelId) {
  const value = MEASURED_THEOS_PER_MILLION[modelId];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * What a request with these token counts cost, by the measured rate.
 *
 * Completion tokens are weighted four times: that is the ratio the two-rate fit produced, and it
 * is what makes a long answer cost more than a long prompt.
 *
 * @param {string} modelId
 * @param {number} promptTokens
 * @param {number} completionTokens
 * @returns {number|null} Credits, or `null` when the model was never measured.
 */
export function theosForUsage(modelId, promptTokens, completionTokens) {
  const rate = theosPerMillion(modelId);
  if (rate === null) return null;
  const prompt = Number.isFinite(promptTokens) ? Math.max(0, promptTokens) : 0;
  const completion = Number.isFinite(completionTokens) ? Math.max(0, completionTokens) : 0;
  const weighted = prompt + COMPLETION_WEIGHT * completion;
  return (rate * weighted) / 1_000_000;
}

/**
 * The measured rate as a short label, in the unit a reader can check against a token count.
 *
 * Per thousand tokens rather than per million, because a request carries thousands: `0.032 Credits / 1k tokens` says what one request costs in a way that `31.7 per million` does not. Three
 * decimals below 0.05 so the cheapest models stay distinguishable from each other and from zero.
 *
 * @param {string} modelId
 * @returns {string|null}
 */
export function measuredRateLabel(modelId) {
  const rate = theosPerMillion(modelId);
  if (rate === null) return null;
  const perThousand = rate / 1_000;
  const digits = perThousand >= 0.1 ? 2 : 3;
  return `${perThousand.toFixed(digits)} Credits / 1k`;
}
