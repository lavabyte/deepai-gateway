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
 * The memory expires, deliberately. A refusal is one request's evidence, and on this wire a
 * refusal is often only a bare `HTTP 400` - "The model provider rejected this request. Try
 * reducing the conversation or attachments, or choose another model." - which a long
 * conversation produces just as easily as an image does. Remembering that against a model
 * forever would mean images silently stop reaching a model that accepts them, with no way
 * back but a restart. So it is remembered for a quarter of an hour: long enough that a
 * conversation is not charged for the same refusal on every turn, short enough that the next
 * attempt is an attempt.
 *
 * Nothing is written to disk. An image is never stored, and no request's messages are
 * rewritten: the filtered list is a copy built for one call, so raising a limit, restarting,
 * or waiting all restore what a caller sends.
 *
 * @module deepai-gateway/deepai/multimodal
 */

/** The backend text that means "multimodal data, not enabled", across spellings. */
const REJECTION = /received multimodal data but multimodal processing is not enabled/i;

/**
 * How long a refusal is remembered.
 *
 * Not a cache of the catalog - this is one model's answer to one kind of request, and it is
 * allowed to be wrong shortly after it is learned.
 */
export const REJECTION_TTL_MS = 15 * 60_000;

/** Models known to reject images, with the moment they may be tried again. */
const rejected = new Map();

/**
 * Whether a failure is the multimodal refusal.
 *
 * @param {unknown} message - the upstream error text.
 * @returns {boolean}
 */
export function isMultimodalRejection(message) {
  return typeof message === 'string' && REJECTION.test(message);
}

/**
 * Record that a model refused multimodal input.
 *
 * @param {string} model
 * @param {number} [now] - the clock, so the expiry can be tested.
 */
export function noteMultimodalRejection(model, now = Date.now()) {
  if (typeof model === 'string' && model !== '') rejected.set(model, now + REJECTION_TTL_MS);
}

/**
 * Whether a model refused images recently enough to send it text instead.
 *
 * @param {string} model
 * @param {number} [now] - the clock, so the expiry can be tested.
 * @returns {boolean}
 */
export function rejectsImages(model, now = Date.now()) {
  const until = rejected.get(model);
  if (until === undefined) return false;
  if (now < until) return true;
  // The memory outlived its evidence: forget it and try the image again.
  rejected.delete(model);
  return false;
}

/** Forget every recorded refusal. For tests, and for a deployment that wants a clean slate. */
export function forgetRejections() {
  rejected.clear();
}
