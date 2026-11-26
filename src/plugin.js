/**
 * Client-owned sessions and the plugin protocol manifest.
 *
 * A plugin owns the transcript. `new_session` hands it an id with the `dgw_client_`
 * prefix; the chat route recognizes that prefix and never reads or writes the replay
 * map. The id is therefore a cache-affinity key, not a conversation row: it survives a
 * gateway restart and needs no sticky routing.
 *
 * The manifest is the contract a new code-tool adapter reads instead of hardcoding
 * paths, headers and history rules.
 *
 * @module deepai-gateway/plugin
 */

import { randomUUID } from 'node:crypto';
import { REQUEST_BODY_BYTES } from './limits.js';

/** Prefix that marks a session as owned by the caller, not by this gateway. */
export const CLIENT_SESSION_PREFIX = 'dgw_client_';

const CLIENT_SESSION_ID = /^dgw_client_[0-9a-f]{32}$/;

/**
 * What the plugin gets from `POST /v1/sessions`.
 *
 * `created` is in OpenAI's seconds, not milliseconds, because the session object sits next
 * to model and completion objects.
 *
 * @param {number} [now]
 * @returns {{object: string, id: string, created: number, mode: string, storage: string, history: string}}
 */
export function newClientSession(now = Date.now()) {
  return {
    object: 'session',
    id: `${CLIENT_SESSION_PREFIX}${randomUUID().replaceAll('-', '')}`,
    created: Math.floor(now / 1000),
    mode: 'client',
    storage: 'client',
    history: 'client',
  };
}

/**
 * Is this a caller-owned session id?
 *
 * Prefix matching, not shape matching, is deliberate on the chat path: a typo after the
 * prefix must still disable replay, otherwise the gateway would silently start storing a
 * transcript the plugin believes it owns.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isClientSession(id) {
  return typeof id === 'string' && id.startsWith(CLIENT_SESSION_PREFIX);
}

/**
 * A well-formed id returned by this gateway. Used by the session endpoints, which should
 * not pretend an arbitrary string has the shape this gateway issues.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isClientSessionId(id) {
  return typeof id === 'string' && CLIENT_SESSION_ID.test(id);
}

/**
 * The session object for a well-formed id. `created` and `parent` are only present when
 * the endpoint knows them; a GET after a restart still has the id but no history to look up.
 *
 * @param {string} id
 * @param {{created?: number, parent?: string}} [fields]
 * @returns {Record<string, unknown>}
 */
export function sessionObject(id, fields = {}) {
  const object = {
    object: 'session',
    id,
    mode: 'client',
    storage: 'client',
    history: 'client',
  };
  if (fields.created !== undefined) object.created = fields.created;
  if (fields.parent !== undefined) object.parent = fields.parent;
  return object;
}

/**
 * The protocol a code-tool plugin implements.
 *
 * It names methods and paths as data so an adapter can fetch it at startup instead of
 * keeping a second copy of the route table.
 *
 * @returns {Record<string, unknown>}
 */
export function pluginManifest() {
  return {
    object: 'gateway.plugin',
    version: 1,
    name: 'deepai-gateway',
    api: '/v1',
    auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
    endpoints: {
      models: { method: 'GET', path: '/v1/models' },
      chat_completions: { method: 'POST', path: '/v1/chat/completions' },
      new_session: { method: 'POST', path: '/v1/sessions' },
      get_session: { method: 'GET', path: '/v1/sessions/{id}' },
      fork_session: { method: 'POST', path: '/v1/sessions/{id}/fork' },
      close_session: { method: 'DELETE', path: '/v1/sessions/{id}' },
    },
    session: {
      mode: 'client',
      storage: 'client',
      server_state: 'none',
      header: 'x-session-id',
      history: 'full',
      note: 'Send the complete transcript with every chat request. Client-owned sessions are never stored or replayed.',
    },
    chat: {
      protocol: 'openai.chat.completions',
      streaming: true,
      tools: true,
      images: true,
      reasoning: true,
      usage: true,
      context: true,
    },
    limits: {
      request_body_bytes: REQUEST_BODY_BYTES,
      context_window: 'per model, see /v1/models',
    },
  };
}
