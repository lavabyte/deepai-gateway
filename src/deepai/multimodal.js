/**
 * Remembering that a backend rejected images even though its catalog advertises them.
 *
 * The DeepAI Code app carries this knowledge between turns. Its own source says why:
 *
 *   // A backend may reject images even when its catalog advertises vision. On a
 *   // later turn with that same model, keep the failed images in saved history.
 *
 * A gateway has no turn to carry it in, so the memory lives here: the first refusal for a
 * model is recorded, and from then on an image for that model is replaced with a note before
 * the request is sent. The refusal itself gets a clear answer at the same time, because
 * retrying it unchanged would fail identically.
 *
 * Nothing is written to disk. DeepAI's catalog is read fresh, and a model that gains real
 * multimodal support costs a restart - which is also what clears a stale entry.
 *
 * @module deepai-gateway/deepai/multimodal
 */

/** The backend text that means "multimodal data, not enabled", across spellings. */
const REJECTION = /received multimodal data but multimodal processing is not enabled/i;

/** Models known to reject images despite declaring them. */
const rejected = new Set();

/**
 * Whether a failure is the multimodal refusal.
 *
 * @param {unknown} message - the upstream error text.
 * @returns {boolean}
 */
export function isMultimodalRejection(message) {
  return typeof message === 'string' && REJECTION.test(message);
}

/** Record that a model refused multimodal input. */
export function noteMultimodalRejection(model) {
  if (typeof model === 'string' && model !== '') rejected.add(model);
}

/**
 * Whether a model has refused images before.
 *
 * @param {string} model
 * @returns {boolean}
 */
export function rejectsImages(model) {
  return rejected.has(model);
}

/** Forget every recorded refusal. For tests, and for a deployment that wants a clean slate. */
export function forgetRejections() {
  rejected.clear();
}