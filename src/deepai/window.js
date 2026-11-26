/**
 * The context numbers this gateway reports, taken from the catalog for each model.
 *
 * DeepAI publishes a `contextWindow` per model. This gateway reports it with real usage so a
 * caller can see how much of the model's capacity the answer occupied. It does not turn that
 * window into a pre-flight byte limit: the endpoint's body limit is not the catalog window,
 * and refusing by estimated bytes rejects conversations that DeepAI would have read. The only
 * context check happens after the answer, from the usage DeepAI reports - see
 * `deepai/context.js`.
 *
 * @module deepai-gateway/deepai/window
 */

/**
 * The context window DeepAI's catalog declares for one model, if it declared one.
 *
 * @param {object|undefined} model
 * @returns {number|undefined}
 */
export function contextWindowOf(model) {
  return Number.isSafeInteger(model?.contextWindow) && model.contextWindow > 0
    ? model.contextWindow
    : undefined;
}
