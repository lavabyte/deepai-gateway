/**
 * Image parts in a chat request, and whether the model can take them.
 *
 * DeepAI accepts OpenAI-style parts on every model and leaves the decision to the
 * backend: a model without vision receives multimodal data its worker was not started
 * with, and two different failures follow. Some models answer *successfully with no
 * content at all* - which reads to a client as a completed turn that said nothing - and
 * others pass a backend error through as `ValueError: Received multimodal data but
 * multimodal processing is not enabled`.
 *
 * The DeepAI Code app does not send an image to a model that does not declare it: its own
 * source replaces the part with a placeholder and says so in the text. This module makes
 * the same decision in the gateway, with one difference: the placeholder is visible in the
 * conversation rather than silent, because the caller is not watching a UI that could
 * annotate it.
 *
 * @module deepai-gateway/deepai/images
 */

/** Part types that carry an image, as OpenAI-shaped clients send them. */
const IMAGE_PART_TYPES = new Set(['image_url', 'input_image']);

/**
 * Count the images in one message.
 *
 * A message's `content` is either a string or a list of parts, and only the list form can
 * carry an image. Anything malformed counts as nothing to send, which is what it would be.
 *
 * @param {unknown} message
 * @returns {number}
 */
function imagesIn(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return 0;
  return content.filter((part) => part !== null && typeof part === 'object'
    && IMAGE_PART_TYPES.has(part.type)).length;
}

/**
 * How many images a request carries.
 *
 * @param {Array<unknown>} messages
 * @returns {number}
 */
export function countImages(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((total, message) => total + imagesIn(message), 0);
}

/** The text that stands in for an image a model cannot take. */
export const OMITTED_IMAGE_TEXT = '[image omitted: this model does not accept images]';

/**
 * Remove the image parts from a request, leaving a note where they were.
 *
 * Every other part is passed through untouched, and a message that was a plain string is
 * returned as it was. The parts that remain keep their order, so a prompt that referred to
 * "the screenshot above" still reads in the order it was written.
 *
 * @param {Array<object>} messages
 * @returns {Array<object>} a new list; the input is not changed.
 */
export function withoutImages(messages) {
  if (!Array.isArray(messages)) return messages;
  let noted = false;
  return messages.map((message) => {
    if (imagesIn(message) === 0) return message;
    const parts = [];
    for (const part of message.content) {
      if (part !== null && typeof part === 'object' && IMAGE_PART_TYPES.has(part.type)) {
        // One note per image, so a caller can tell how many were dropped.
        parts.push({ type: 'text', text: OMITTED_IMAGE_TEXT });
        continue;
      }
      parts.push(part);
    }
    noted = true;
    void noted;
    return { ...message, content: parts };
  });
}

/**
 * Whether a model declares image input.
 *
 * A model the catalog does not know is treated as unable to take an image: the alternative
 * is sending one to a backend that will answer with nothing, which is the failure this
 * exists to prevent.
 *
 * @param {{input?: string[]}|undefined} model
 * @returns {boolean}
 */
export function acceptsImages(model) {
  return Array.isArray(model?.input) && model.input.includes('image');
}
