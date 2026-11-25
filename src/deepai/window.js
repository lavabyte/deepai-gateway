/**
 * The context numbers this gateway uses, taken from the catalog for each model.
 *
 * There is no window, wall or character budget in this file. DeepAI publishes a
 * `contextWindow` per model; the desktop app reads that same number and compacts at
 * `contextWindow - reserveTokens`. This gateway measures against the same point and refuses
 * a prompt past it, so a model that DeepAI changes is picked up on the next catalog read
 * instead of needing a code change.
 *
 * The earlier revisions here baked in `320000`, a measured 196 KB "wall" and a 176,400-byte
 * budget. Those numbers came from one endpoint at one time. The measured wall in particular is
 * not the model's window and cannot be derived from the catalog, so it must not be a policy
 * constant: a gateway that hardcodes it starts refusing healthy conversations when DeepAI
 * changes the backend, and forwards already-doomed ones when the real limit moves the other way.
 * The fixed numbers are gone; an operator who has measured a tighter limit for their deployment
 * can still set `PROMPT_BUDGET_BYTES`, and otherwise the model's own catalog entry is the only
 * limit.
 *
 * @module deepai-gateway/deepai/window
 */

/**
 * Characters per token: the estimator used when DeepAI sends no usage.
 *
 * This is a meter, not a policy. It is the same four characters per token that fills
 * `prompt_tokens` in `estimateUsage`, so a client's context gauge and this gateway's budget
 * agree about how full a prompt is. It is deliberately not a limit on the model.
 */
export const CHARS_PER_TOKEN = 4;

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

/**
 * The prompt budget for one model, in bytes, derived from its catalog entry.
 *
 * The reserve is the model's own output allowance: the app compacts and this gateway refuses at
 * `contextWindow - reserveTokens`, because a prompt plus the answer has to fit the same window.
 * Nothing is filled in when the catalog did not send a window - returning `undefined` means
 * "no local limit known", not an invented one.
 *
 * @param {object|undefined} model
 * @returns {number|undefined} bytes the gateway may send as prompt.
 */
export function promptBudgetFor(model) {
  const window = contextWindowOf(model);
  if (window === undefined) return undefined;
  const output = Number.isSafeInteger(model?.maxTokens) && model.maxTokens > 0
    ? model.maxTokens
    : 0;
  if (output >= window) return undefined;
  return (window - output) * CHARS_PER_TOKEN;
}
