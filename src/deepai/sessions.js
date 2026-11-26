/**
 * Conversation identity for DeepAI's prompt cache.
 *
 * DeepAI addresses a conversation's cache by the session id this gateway sends (`session_id`,
 * `x-client-request-id`, `x-session-affinity`). The gateway does not need to remember anything
 * to choose that id: a caller's own `x-session-id`, `session_id` or `x-session-affinity` wins,
 * and otherwise the id is derived from the conversation's opening. The opening is the first user
 * message, not the system prompt, because harnesses rewrite the system prompt between turns
 * (date, cwd, model name).
 *
 * This is deliberately stateless. There is no conversation table, no expiry and no per-account
 * cap. DeepAI owns the prompt cache and its lifetime; the gateway only sends a stable id so
 * turns of one conversation land on the same cache. If the caller compacts, the first user
 * message changes, the id changes with it, and the endpoint starts a new cache for the new
 * transcript - which is exactly what happened to the transcript itself.
 *
 * The account is part of the seed: two accounts sending byte-identical prompts are two
 * conversations on two DeepAI accounts and must not be handed the same session id.
 *
 * @module deepai-gateway/deepai/sessions
 */

import { createHash } from 'node:crypto';

/**
 * The text of one message, for hashing.
 *
 * @param {unknown} message
 * @returns {string}
 */
function messageText(message) {
  if (message === null || typeof message !== 'object') return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (part !== null && typeof part === 'object' && typeof part.text === 'string') text += part.text;
  }
  return text;
}

/**
 * A stable id for one conversation, derived from how it begins.
 *
 * The first user message is what every turn of a conversation carries unchanged, even when the
 * harness rewrites its system prompt. Hashing it gives an id that is the same on turn 1 and turn
 * 40 and different from another conversation's. Only the first few thousand characters are
 * hashed: enough to tell conversations apart, little enough that the hash costs nothing on a long
 * prompt.
 *
 * A transcript with no user message falls back to its first non-system message, and then to its
 * first message, so a request still gets a deterministic id rather than a random one.
 *
 * @param {unknown} messages
 * @param {string} [owner]
 * @returns {string} 32 hex characters, the shape DeepAI's own session ids have.
 */
export function conversationId(messages, owner = '') {
  const list = Array.isArray(messages) ? messages : [];
  const anchor = list.find((message) => message?.role === 'user')
    ?? list.find((message) => message?.role !== 'system' && message?.role !== 'developer')
    ?? list[0];
  const seed = `${owner}\u0000${messageText(anchor).slice(0, 4096)}`;
  return createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 32);
}
