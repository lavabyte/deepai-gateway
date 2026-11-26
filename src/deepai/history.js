/**
 * Ephemeral replay for callers that send only the new turn.
 *
 * DeepAI's completion endpoint is stateless: every turn must carry the whole transcript. A
 * caller can always do that itself, and this gateway forwards the transcript unchanged. But some
 * clients only send the newest message and rely on a session to hold the rest - a pattern that
 * cannot work against a stateless endpoint unless something reconstructs the transcript.
 *
 * This module is that something, and it is deliberately small: a bounded, in-memory map from a
 * caller-supplied session id to the last successful transcript. It never writes to disk, never
 * survives a restart, and is only consulted when the caller named the session explicitly. A
 * request without a session header keeps the stateless behaviour: its id is derived from the
 * opening and no transcript is remembered.
 *
 * The map is not a conversation database. It holds at most a fixed number of transcripts and a
 * fixed number of bytes, evicts the least recently used entry, and expires idle entries. A
 * process restart simply means the next request has to carry its own history again.
 *
 * @module deepai-gateway/deepai/history
 */

/** How many conversations one process may remember. */
export const DEFAULT_HISTORY_ENTRIES = 128;

/** How many bytes of transcripts one process may remember. */
export const DEFAULT_HISTORY_BYTES = 32 * 1024 * 1024;

/** How long an idle conversation is kept, refreshed by every use. */
export const DEFAULT_HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const SYSTEM_ROLES = new Set(['system', 'developer']);

/**
 * Whether a message carries instructions rather than conversation.
 *
 * @param {unknown} message
 * @returns {boolean}
 */
function isSystem(message) {
  return message !== null && typeof message === 'object' && SYSTEM_ROLES.has(message.role);
}

/**
 * Whether a request is one new turn rather than a full transcript.
 *
 * A single `user` message is the ordinary continuation. A single `tool` message is the same
 * shape for an agent returning a tool result. Anything with an assistant message, or with more
 * than one conversational message, is a transcript the caller already owns - it replaces the
 * remembered one instead of being appended to it, which is also how a rewind is represented.
 *
 * @param {unknown} messages
 * @returns {boolean}
 */
export function isOneTurn(messages) {
  if (!Array.isArray(messages)) return false;
  const conversational = messages.filter((message) => !isSystem(message));
  if (conversational.length !== 1) return false;
  const role = conversational[0]?.role;
  return role === 'user' || role === 'tool';
}

/**
 * Prepend the remembered transcript to one new turn.
 *
 * The incoming system/developer messages win, because a harness rewrites them between turns
 * (date, working directory, model name) and the newest one is the instruction the model should
 * see. Everything else keeps its original order. Returns `undefined` when the incoming request
 * is not a one-turn continuation, so the caller can send it unchanged.
 *
 * @param {unknown[]} stored
 * @param {unknown[]} incoming
 * @returns {unknown[] | undefined}
 */
export function mergeHistory(stored, incoming) {
  if (!Array.isArray(stored) || stored.length === 0) return undefined;
  if (!isOneTurn(incoming)) return undefined;
  const system = incoming.filter(isSystem);
  const turn = incoming.filter((message) => !isSystem(message));
  const history = system.length > 0 ? stored.filter((message) => !isSystem(message)) : stored;
  return [...system, ...history, ...turn];
}

/**
 * A bounded in-memory transcript map.
 *
 * Keys include the account owner, so two accounts that happen to send the same session id can
 * never read each other's transcript. Values are the full message arrays last sent upstream,
 * not deltas: replay always rebuilds one complete prompt for the stateless endpoint.
 */
export class ConversationHistory {
  /**
   * @param {{maxEntries?: number, maxBytes?: number, ttlMs?: number, now?: () => number}} [options]
   */
  constructor(options = {}) {
    this.maxEntries = positive(options.maxEntries, DEFAULT_HISTORY_ENTRIES);
    this.maxBytes = positive(options.maxBytes, DEFAULT_HISTORY_BYTES);
    this.ttlMs = positive(options.ttlMs, DEFAULT_HISTORY_TTL_MS);
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    /**
     * Each entry also keeps the last usage DeepAI reported for that transcript - its prompt
     * token count, the model that produced it and the text size that was sent. They are not
     * conversation state: they are the baseline for noticing that a replay was answered from
     * less than it carried.
     *
     * @type {Map<string, {messages: unknown[], bytes: number, expiresAt: number, promptTokens?: number, textBytes?: number, model?: string}>}
     */
    this.entries = new Map();
    this.bytes = 0;
  }

  /**
   * Read a transcript and merge it with one new turn.
   *
   * Returns `undefined` when there is nothing to merge, when the entry expired, or when the
   * request is a full transcript. A hit refreshes the entry's idle time and its LRU position.
   *
   * @param {string} owner
   * @param {string} sessionId
   * @param {unknown} incoming
   * @returns {unknown[] | undefined}
   */
  recall(owner, sessionId, incoming) {
    const key = this.key(owner, sessionId);
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    const now = this.now();
    if (entry.expiresAt <= now) {
      this.remove(key);
      return undefined;
    }
    const merged = mergeHistory(entry.messages, incoming);
    if (merged === undefined) return undefined;
    entry.expiresAt = now + this.ttlMs;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return merged;
  }

  /**
   * The usage DeepAI reported for the transcript currently remembered.
   *
   * Used for one comparison only: a replay must be read as at least the prompt that was
   * remembered, so a smaller reported prompt token count means DeepAI answered from a
   * shortened body. Nothing is returned when the last answer had no usage, or when the caller
   * switched models, because a different tokenizer makes the two counts incomparable.
   *
   * @param {string} owner
   * @param {string} sessionId
   * @param {string} model - the model this request will use.
   * @returns {{promptTokens: number, textBytes: number} | undefined}
   */
  lastPrompt(owner, sessionId, model) {
    const key = this.key(owner, sessionId);
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.remove(key);
      return undefined;
    }
    if (entry.model !== model
      || !Number.isFinite(entry.promptTokens)
      || !Number.isFinite(entry.textBytes)) {
      return undefined;
    }
    return { promptTokens: entry.promptTokens, textBytes: entry.textBytes };
  }

  /**
   * Remember the transcript that was just sent, replacing the previous one.
   *
   * A transcript larger than the whole budget is not remembered at all rather than evicting
   * every other conversation for it.
   *
   * @param {string} owner
   * @param {string} sessionId
   * @param {unknown} messages
   * @param {{promptTokens?: number, textBytes?: number, model?: string}} [usage]
   * @returns {boolean} whether it was kept.
   */
  remember(owner, sessionId, messages, usage = {}) {
    if (!Array.isArray(messages) || messages.length === 0) return false;
    const key = this.key(owner, sessionId);
    let bytes;
    try {
      bytes = Buffer.byteLength(JSON.stringify(messages), 'utf8');
    } catch {
      // An unserializable transcript is not one that can replace the old one.
      this.remove(key);
      return false;
    }
    if (bytes > this.maxBytes) {
      // Do not leave an older transcript to be replayed as if it were this one.
      this.remove(key);
      return false;
    }
    this.prune();
    this.remove(key);
    const expiresAt = this.now() + this.ttlMs;
    const promptTokens = Number.isFinite(usage.promptTokens) && usage.promptTokens > 0
      ? usage.promptTokens
      : undefined;
    const textBytes = Number.isFinite(usage.textBytes) && usage.textBytes > 0
      ? usage.textBytes
      : undefined;
    const model = typeof usage.model === 'string' && usage.model !== '' ? usage.model : undefined;
    this.entries.set(key, {
      messages: messages.slice(),
      bytes,
      expiresAt,
      ...(promptTokens === undefined || textBytes === undefined || model === undefined
        ? {}
        : { promptTokens, textBytes, model }),
    });
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries) {
      this.remove(this.entries.keys().next().value);
    }
    while (this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === key) break;
      this.remove(oldest);
    }
    return this.entries.has(key);
  }

  /** Remove expired entries. */
  prune() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.remove(key);
    }
  }

  /**
   * The number of conversations currently remembered.
   * @returns {number}
   */
  get size() {
    return this.entries.size;
  }

  /**
   * @param {string} owner
   * @param {string} sessionId
   * @returns {string}
   */
  key(owner, sessionId) {
    return `${owner}\u0000${sessionId}`;
  }

  /**
   * @param {string} key
   */
  remove(key) {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.bytes -= entry.bytes;
    this.entries.delete(key);
  }
}

/**
 * A positive whole number, or the default.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positive(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
