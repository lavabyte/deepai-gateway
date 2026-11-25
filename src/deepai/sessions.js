/**
 * Conversation identity: one session per conversation, across compaction and restarts.
 *
 * DeepAI addresses a conversation's prompt cache by the session id this gateway sends
 * (`session_id`, `x-client-request-id`, `x-session-affinity`). Once that prefix is cached the
 * endpoint reads only the new tail fresh and serves the rest from cache, which is how the
 * desktop app runs conversations of ~290k prompt tokens: `data/deepai.db` in this repository
 * holds answers with 720,896 cached prompt tokens against 155 fresh ones, and the app's own
 * session store holds 1.7 MB request bodies answered with 291,328 cached tokens and 424 fresh.
 *
 * Deriving the id from the transcript opening (`conversationId`) keeps it stable from turn to
 * turn - until the harness compacts, replacing the opening with a summary, or rewrites its
 * system prompt, which harnesses do (date, cwd, model name). Then the id changes, the endpoint
 * has no cache for it, the whole multi-megabyte transcript has to be read fresh, and a prompt
 * past the endpoint's limit for a cold request has its front silently discarded (see
 * `deepai/window.js`). From a caller that looks like a working conversation answered as though
 * it had just been opened.
 *
 * This module keeps the id stable across that, and remembers a fingerprint of the opening as
 * well as the digest of each of the last few messages that are not `system`/`developer` (those are
 * the ones a harness rewrites). A request that shares a run of those digests with a remembered
 * conversation is a continuation of it, and reuses its session id; its tail counts as cached only
 * when the opening fingerprint still matches. A prompt whose fresh part is over the model's budget
 * is refused by the caller, which can compact its own session and try again.
 *
 * **What is stored is digests and one opening fingerprint** - one SHA-256 hex digest per message
 * plus a hash of the system prompt, tools and opening messages, never the text itself. It is a
 * cache key, not a transcript: the gateway does not keep anybody's conversation. Nothing read from
 * this table is sent to DeepAI or injected into a prompt; it only decides which `session_id` header
 * goes on the request, and which part of the prompt the fresh-byte guard has to count.
 *
 * The row has no local lifetime. DeepAI owns the prompt cache and its expiry; this table only
 * remembers where the conversation got to, so the next turn can be matched to it. A row is removed
 * when its account is deleted, or when the endpoint answers an over-budget body with no cache hit
 * at all - the server's own signal that the hint is stale. There is no seven-day sweep and no
 * per-account cap: the cache's lifetime is DeepAI's decision, not a timer here.
 *
 * Isolation is per account: a row is looked up by `owner`, and a row belonging to another
 * account never matches, whatever the transcript says.
 *
 * @module deepai-gateway/deepai/sessions
 */

import { createHash } from 'node:crypto';

/** How many trailing message digests one row keeps. */
export const TAIL_MESSAGES = 40;

/** How many digests a request has to share with a remembered conversation to continue it. */
export const MIN_SHARED_MESSAGES = 3;

/**
 * How close to the end of both sides the newest shared digest has to be.
 *
 * A conversation grows at its end, so the newest message two turns of it share is near the end
 * of the older turn and near the end of the newer one. A shared digest that is only near the
 * end on one side is a repeated line (`ok`, a tool-call echo) rather than the same turn, and it
 * is not enough to join two conversations.
 */
export const RECENT_MESSAGES = 8;

/** The shape of one entry in a stored tail: a SHA-256 digest in hex. */
const DIGEST = /^[0-9a-f]{64}$/;

/**
 * The text of one message, for hashing and for counting.
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

/** Whether a message is one a harness may rewrite between turns. */
function isSystemish(message) {
  return message?.role === 'system' || message?.role === 'developer';
}

/**
 * One message's digest, or `undefined` for the roles that are not part of the tail.
 *
 * @param {unknown} message
 * @returns {string|undefined} 64 hex characters.
 */
function digestOf(message) {
  if (message === null || typeof message !== 'object') return undefined;
  if (isSystemish(message)) return undefined;
  return createHash('sha256').update(JSON.stringify(message), 'utf8').digest('hex');
}

/**
 * The digests of the newest messages of one request, newest last.
 *
 * `system` and `developer` messages are left out on purpose: they are what a harness rewrites
 * between turns (dates, cwd, model name, environment blocks), and a conversation is still the
 * same conversation after that. Everything else is hashed exactly as it would be sent, so two
 * requests agree about a message only when the endpoint would see the same bytes.
 *
 * @param {unknown} messages
 * @returns {string[]} up to {@link TAIL_MESSAGES} digests.
 */
export function messageDigests(messages) {
  const digests = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const digest = digestOf(message);
    if (digest !== undefined) digests.push(digest);
  }
  return digests.slice(-TAIL_MESSAGES);
}

/**
 * A stable id for one conversation, derived from how it begins.
 *
 * The system prompt and the first user message are what every turn of a conversation carries
 * unchanged, so hashing them gives an id that is the same on turn 1 and turn 40 and different
 * from another conversation's. Only the first few thousand characters are hashed: enough to
 * tell conversations apart, little enough that the hash costs nothing on a long prompt.
 *
 * This is the fallback, used when no remembered conversation continues into this request - a
 * first turn, or a conversation this gateway has not seen since a restart that lost the row.
 *
 * The account is part of the seed: two accounts sending byte-identical prompts are two
 * conversations on two DeepAI accounts, and they must not be handed the same session id.
 *
 * @param {unknown} messages
 * @param {string} [owner]
 * @returns {string} 32 hex characters, the shape DeepAI's own session ids have.
 */
export function conversationId(messages, owner = '') {
  const list = Array.isArray(messages) ? messages : [];
  const system = list.find(isSystemish);
  const firstUser = list.find((message) => message?.role === 'user');
  const seed = `${owner}\u0000${messageText(system).slice(0, 4096)}\u0000${messageText(firstUser).slice(0, 4096)}`;
  return createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 32);
}

/**
 * A fingerprint of the part of a request that cannot change without invalidating the cache.
 *
 * The endpoint caches a prompt prefix. Everything before the first assistant message - the
 * system prompt, the tool catalog, the task and the harness's opening context - is that prefix
 * on every turn. A harness may rewrite its system block (date, cwd, model name) or its tool list;
 * when it does, the old cache no longer describes this request, and treating the remembered tail
 * as cached would forward a cold prompt too large to read. Hashing only the opening keeps the
 * fingerprint stable as the conversation grows, which is what lets a continuation stay warm.
 *
 * @param {unknown} messages
 * @param {unknown} tools
 * @returns {string} 64 hex characters.
 */
function prefixHash(messages, tools) {
  const list = Array.isArray(messages) ? messages : [];
  const systems = list.filter(isSystemish);
  const opening = [];
  for (const message of list) {
    if (isSystemish(message)) continue;
    if (message?.role === 'assistant') break;
    opening.push(message);
  }
  return createHash('sha256').update(JSON.stringify({
    v: 1,
    systems,
    tools: Array.isArray(tools) ? tools : [],
    opening,
  }), 'utf8').digest('hex');
}

/**
 * The digests and opening fingerprint a stored row carries.
 *
 * A row is a cache hint, never a source of truth: an unreadable one is treated as empty, which
 * makes the request cold rather than failing it. Rows written before the fingerprint existed are
 * arrays of digests; they are still read, with no fingerprint to check. A `compacted` flag is
 * read from rows written by older versions that rewrote prompts; those rows are still cold.
 *
 * @param {{tail?: unknown}} row
 * @returns {{prefix?: string, digests: string[], compacted: boolean}}
 */
function parseStored(row) {
  try {
    const value = JSON.parse(row?.tail ?? '[]');
    const digests = (list) => (Array.isArray(list)
      ? list.filter((digest) => typeof digest === 'string' && DIGEST.test(digest))
      : []);
    if (Array.isArray(value)) return { digests: digests(value), compacted: false };
    if (value !== null && typeof value === 'object') {
      return {
        prefix: typeof value.prefix === 'string' && DIGEST.test(value.prefix) ? value.prefix : undefined,
        digests: digests(value.tail),
        compacted: value.compacted === true,
      };
    }
  } catch {
    // Fall through to the empty row below.
  }
  return { digests: [], compacted: false };
}

/** One row, by session id, if it belongs to this account. */
function rowFor(db, sessionId, owner) {
  return db.prepare(
    'SELECT session_id, tail, updated_at FROM conversation_sessions WHERE session_id = ? AND owner = ?',
  ).get(sessionId, owner);
}

/**
 * The remembered conversation this request continues, if there is one.
 *
 * A continuation shares at least {@link MIN_SHARED_MESSAGES} message digests with a remembered
 * tail and its newest shared digest sits among the last {@link RECENT_MESSAGES} of both sides.
 * The row with the most shared digests wins; ties are broken by recency, so two conversations
 * that look equally like this one resolve to the one used last.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} owner
 * @param {string[]} digests - this request's tail.
 * @param {string} prefix - this request's opening fingerprint.
 * @returns {{sessionId: string, covered: string[]}|undefined}
 */
function continuationOf(db, owner, digests, prefix) {
  if (digests.length < MIN_SHARED_MESSAGES) return undefined;
  const rows = db.prepare(
    'SELECT session_id, tail, updated_at FROM conversation_sessions WHERE owner = ? '
    + 'ORDER BY updated_at DESC',
  ).all(owner);

  const currentPosition = new Map();
  digests.forEach((digest, index) => currentPosition.set(digest, index));

  let best;
  for (const row of rows) {
    const { prefix: storedPrefix, digests: stored, compacted } = parseStored(row);
    if (stored.length === 0) continue;
    /*
     * A changed opening - a harness compaction, a rewritten system prompt, a new tool catalog -
     * still belongs to the same conversation, so its id is kept. Nothing of its prefix is cached,
     * though: the caller measures the whole prompt fresh, and refuses it if it is too large. A row
     * written by a version that compacted here is cold for the same reason: the endpoint cached
     * the checkpoint, not the caller's original transcript that arrives next turn.
     */
    const cold = compacted || (storedPrefix !== undefined && storedPrefix !== prefix);
    const storedPosition = new Map();
    stored.forEach((digest, index) => storedPosition.set(digest, index));

    let shared = 0;
    let newestHere = -1;
    let newestThere = -1;
    for (const [digest, index] of currentPosition) {
      const there = storedPosition.get(digest);
      if (there === undefined) continue;
      shared += 1;
      if (index > newestHere) {
        newestHere = index;
        newestThere = there;
      }
    }
    if (shared < MIN_SHARED_MESSAGES) continue;
    if (newestHere < digests.length - RECENT_MESSAGES) continue;
    if (newestThere < stored.length - RECENT_MESSAGES) continue;
    if (best === undefined || shared > best.shared) {
      best = { sessionId: row.session_id, covered: cold ? [] : stored, shared };
    }
  }
  return best;
}

/** How many of `digests` appear in `covered`. */
function sharedCount(covered, digests) {
  if (covered.length === 0) return 0;
  const known = new Set(covered);
  let shared = 0;
  for (const digest of digests) if (known.has(digest)) shared += 1;
  return shared;
}

/**
 * Which session id a request belongs to, and what of its prompt is already cached under it.
 *
 * Three cases, in order:
 *
 *  1. the caller named its conversation (`x-session-id`), and that always wins;
 *  2. a remembered conversation continues into this request, so its id is reused; its tail is
 *     counted as cached only if the opening fingerprint still matches, so a harness compaction or
 *     a rewritten system prompt keeps the id but is measured cold;
 *  3. otherwise the id derived from the transcript opening, which is stable for a conversation
 *     this gateway has never seen (a first turn, or a row lost to a restart).
 *
 * `covered` is the remembered tail this request continues under that id - the set of message
 * digests the endpoint should already have cached, or empty when the opening fingerprint changed
 * or nothing is known. `reused` says whether this request genuinely continues a remembered tail,
 * which needs {@link MIN_SHARED_MESSAGES} of its messages to be in it: the fallback id is derived
 * from the first few thousand characters, so two unrelated conversations can open identically and
 * be handed the same row, and one coincidentally equal message - a repeated `ok`, a tool echo - is
 * not enough to call that cached. When `reused` is false the caller measures the whole prompt as
 * fresh, which is the safe direction: over-counting fresh refuses a request that might have fit,
 * while under-counting fresh is the silent truncation this exists to prevent.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{owner: string, messages: unknown, tools?: unknown, callerSessionId?: unknown}} params
 * @returns {{sessionId: string, reused: boolean, covered: string[]}}
 */
export function resolveSession(db, { owner, messages, tools, callerSessionId }) {
  const digests = messageDigests(messages);
  const prefix = prefixHash(messages, tools);

  if (typeof callerSessionId === 'string' && callerSessionId !== '') {
    /*
     * A caller that names its own conversation knows better than any heuristic here. Its id is
     * forwarded verbatim - the app does the same with its per-thread id - and a tail stored under
     * it is reused, so the fresh part is measured from where that conversation got to.
     */
    const row = rowFor(db, callerSessionId, owner);
    const stored = parseStored(row);
    const shared = sharedCount(stored.digests, digests);
    const cold = stored.compacted || (stored.prefix !== undefined && stored.prefix !== prefix);
    const covered = cold ? [] : stored.digests;
    return { sessionId: callerSessionId, reused: shared >= MIN_SHARED_MESSAGES, covered };
  }

  const continuation = continuationOf(db, owner, digests, prefix);
  if (continuation !== undefined) {
    return { sessionId: continuation.sessionId, reused: true, covered: continuation.covered };
  }

  const sessionId = conversationId(messages, owner);
  const row = rowFor(db, sessionId, owner);
  const stored = parseStored(row);
  const shared = sharedCount(stored.digests, digests);
  const cold = stored.compacted || (stored.prefix !== undefined && stored.prefix !== prefix);
  const covered = cold ? [] : stored.digests;
  return { sessionId, reused: shared >= MIN_SHARED_MESSAGES, covered };
}

/**
 * The messages the endpoint has to read fresh under the tail it has already cached.
 *
 * Everything up to and including the newest message that matches a stored digest is treated as
 * cached; what follows is fresh. With no stored tail - a cold conversation - the whole prompt is
 * fresh, which is the number the byte budget has always measured.
 *
 * This is a cache hint, not an assertion about what the endpoint kept: when a session's cache has
 * expired server-side, the endpoint reads the whole prompt fresh again whatever this returns.
 * Nothing here can tell that apart; the log line for a request that came back with no cache hit
 * is what makes it visible.
 *
 * @param {string[]} covered - digests from {@link resolveSession}.
 * @param {unknown} messages
 * @returns {Array<object>} the fresh part, in order; `messages` itself when nothing is covered.
 */
export function freshMessages(covered, messages) {
  const list = Array.isArray(messages) ? messages : [];
  if (!Array.isArray(covered) || covered.length === 0) return list;

  /*
   * A contiguous run, not any shared message. The remembered value is the tail of the previous
   * request, so it appears in this one as one run followed by whatever is new. Requiring the run
   * to match in order means a rewritten message in the middle stops the cache there instead of
   * letting a later echo of a digest make the gateway call the whole prefix cached - the
   * under-count that forwarded a cold 437 KB transcript and let DeepAI discard its start.
   */
  const digests = [];
  const positions = [];
  list.forEach((message, index) => {
    const digest = digestOf(message);
    if (digest !== undefined) {
      digests.push(digest);
      positions.push(index);
    }
  });
  let best = { matched: 0, start: -1 };
  for (let start = 0; start < digests.length; start += 1) {
    if (digests[start] !== covered[0]) continue;
    let matched = 1;
    while (matched < covered.length && start + matched < digests.length
      && digests[start + matched] === covered[matched]) matched += 1;
    // The newest run wins a tie: that is the previous request's tail, not an older echo of it.
    if (matched >= best.matched) best = { matched, start };
  }
  if (best.matched === 0) return list;
  const lastCached = positions[best.start + best.matched - 1];
  return list.slice(lastCached + 1);
}

/**
 * Remember where a conversation got to, so the next turn continues it.
 *
 * Called once a request has actually been answered: the row is a record of what the endpoint
 * received, so a request that never left the gateway must not teach it anything. The tail of the
 * row is this request's last {@link TAIL_MESSAGES} digests, which is what the next turn is
 * matched against. `updated_at` only breaks ties in favour of the most recently used conversation;
 * it is not an expiry date.
 *
 * `session_id` is the primary key, so a session id is remembered once. Two accounts that send the
 * same caller-chosen `x-session-id` therefore keep a row for whichever used it first, and the
 * other one stays cold - it is never matched against a row it does not own. That is the safe side
 * of the collision: a missing row costs a cold request, a shared one would cost isolation.
 *
 * The row also carries a fingerprint of the request's opening - system prompt, tools, and the
 * messages before the first assistant reply - so a later request whose opening was rewritten is
 * treated as cold instead of trusting a tail the endpoint's cache no longer describes.
 *
 * `messages` are the caller's transcript as it arrived: the next turn will carry the same version,
 * and matching it is what keeps the session id stable.
 *
 * @param {{sessionId: string, owner: string, keyId?: string|null, messages: unknown, tools?: unknown, now?: number}} params
 * @returns {void}
 */
export function rememberSession(db, { sessionId, owner, keyId, messages, tools, now = Date.now() }) {
  db.prepare(`
    INSERT INTO conversation_sessions (session_id, owner, key_id, tail, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      key_id     = excluded.key_id,
      tail       = excluded.tail,
      updated_at = excluded.updated_at
    WHERE conversation_sessions.owner = excluded.owner
  `).run(sessionId, owner, keyId ?? null, JSON.stringify({
    prefix: prefixHash(messages, tools),
    tail: messageDigests(messages),
  }), now);
}

/**
 * Forget one cache hint.
 *
 * Used when DeepAI itself says the hint is stale: an over-budget body that came back with zero
 * cached tokens was read fresh despite the row. Keeping the row would make the next turn trust a
 * prefix the endpoint no longer has. This removes only this account's row for this session id.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{sessionId: string, owner: string}} params
 * @returns {void}
 */
export function forgetSession(db, { sessionId, owner }) {
  db.prepare('DELETE FROM conversation_sessions WHERE session_id = ? AND owner = ?')
    .run(sessionId, owner);
}
