/**
 * Stateless session mechanics for code-tool plugins.
 *
 * These are id helpers and a discovery manifest, not a transcript store. A session is an
 * opaque affinity id: the caller keeps the messages and sends the whole transcript to
 * `/v1/sessions/{id}/messages`. There is no row to read, fork or delete, so every helper
 * here is a pure function of the id.
 *
 * @module deepai-gateway/sessions
 */

import { randomBytes } from 'node:crypto';
import { REQUEST_BODY_BYTES } from './limits.js';

export const SESSION_PREFIX = 'dgw_sess_';

/*
 * Server-issued ids are `dgw_sess_` plus 32 hex characters. A client-generated UUID v4 is
 * accepted too, because the SDK creates the id locally and must be able to use the session
 * endpoint without a registration round trip.
 */
const SESSION_ID = /^(?:dgw_sess_[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

/**
 * A new session id. The caller is expected to keep the transcript.
 *
 * @returns {{object: string, id: string, mode: string, storage: string, history: string, created: number}}
 */
export function newSession() {
  return sessionObject(`${SESSION_PREFIX}${randomBytes(16).toString('hex')}`, {
    created: Date.now(),
  });
}

/**
 * Accept only the two shapes the gateway issues or its SDK creates.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value);
}

/**
 * The state-free descriptor of a session id.
 *
 * @param {string} id
 * @param {object} [extra]
 * @returns {object}
 */
export function sessionObject(id, extra = {}) {
  return {
    object: 'session',
    id,
    mode: 'client',
    storage: 'client',
    history: 'client',
    ...extra,
  };
}

/**
 * The discovery document for adapters that would otherwise duplicate the route table.
 *
 * @returns {object}
 */
export function pluginManifest() {
  return {
    object: 'gateway.plugin',
    version: 1,
    api: '/v1',
    session: {
      mode: 'client',
      storage: 'client',
      server_state: 'none',
      header: 'x-session-id',
      history: 'full',
    },
    endpoints: {
      chat_completions: { method: 'POST', path: '/v1/chat/completions' },
      new_session: { method: 'POST', path: '/v1/sessions' },
      get_session: { method: 'GET', path: '/v1/sessions/{id}' },
      send_message: { method: 'POST', path: '/v1/sessions/{id}/messages' },
      fork_session: { method: 'POST', path: '/v1/sessions/{id}/fork' },
      close_session: { method: 'DELETE', path: '/v1/sessions/{id}' },
    },
    limits: { request_body_bytes: REQUEST_BODY_BYTES },
  };
}