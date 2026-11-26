/**
 * Catching a replay that DeepAI answered from only part of.
 *
 * There is no exact token count before a request is sent, and the endpoint's body limit is
 * not a catalog number. Measuring the body first would either refuse healthy conversations or
 * forward a request that is silently shortened. So the check happens after DeepAI answers,
 * where it reports what it actually read: `usage.prompt_tokens`.
 *
 * For a one-turn continuation the gateway already holds the transcript it replayed. The next
 * prompt necessarily contains that transcript plus the new turn, so its reported prompt token
 * count cannot be lower than the previous turn's. A drop beyond ordinary accounting noise is the
 * observable trace of the endpoint dropping the prefix. It is a comparison of two output values,
 * not a pre-flight size limit.
 *
 * @module deepai-gateway/deepai/context
 */

/** Do not flag a difference that a small accounting change can explain. */
const TOLERANCE_RATIO = 0.02;
const MIN_TOLERANCE_TOKENS = 256;

/**
 * Whether a replayed prompt was answered from less than it carried.
 *
 * `previous` is the usage reported for the transcript in the replay map and `current` is the
 * usage reported for this answer. `textBytes` is the prompt text that was actually sent, with
 * image payloads excluded, so an image never looks like a large token increase.
 *
 * The new prompt still contains the remembered transcript, so its reported prompt count cannot
 * be lower than the count reported for that transcript unless the endpoint stopped reading it.
 * A 2%/256-token tolerance absorbs ordinary accounting noise. Returns `undefined` when there is
 * nothing to compare: no prior usage, no current usage, or a prompt that did not grow.
 *
 * @param {{promptTokens: number, textBytes: number} | undefined} previous
 * @param {number | undefined} current
 * @param {number} textBytes - text bytes in the prompt just sent.
 * @returns {{previousTokens: number, currentTokens: number} | undefined}
 */
export function forgottenReplay(previous, current, textBytes) {
  if (previous === undefined || !Number.isFinite(current) || current < 1) return undefined;
  if (!Number.isFinite(previous.promptTokens) || previous.promptTokens < 1) return undefined;
  if (!Number.isFinite(previous.textBytes) || !Number.isFinite(textBytes)) return undefined;
  if (textBytes <= previous.textBytes) return undefined;
  const tolerance = Math.max(
    MIN_TOLERANCE_TOKENS,
    Math.floor(previous.promptTokens * TOLERANCE_RATIO),
  );
  if (current + tolerance >= previous.promptTokens) return undefined;
  return {
    previousTokens: previous.promptTokens,
    currentTokens: current,
  };
}
