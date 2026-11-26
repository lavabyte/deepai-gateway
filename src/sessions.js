/**
 * Minimal session ids for the gateway's second surface.
 *
 * A session is only an affinity id: the client stores the transcript, branches and lifetime.
 * The gateway mints an id and accepts it on `/v1/sessions/{id}/messages`; it keeps no row and
 * has no get, fork or delete route.
 *
 * @module deepai-gateway/sessions
 */

import { randomBytes } from 'node:crypto';

export const SESSION_PREFIX = 'dgw_sess_';

/*
 * Server-issued ids are `dgw_sess_` plus 32 hex characters. A client-generated UUID v4 is
 * accepted too, because the SDK creates its session locally and can use the session route
 * without first asking the gateway for an id.
 */
const SESSION_ID = /^(?:dgw_sess_[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

/** @returns {string} a new opaque session id */
export function newSessionId() {
  return `${SESSION_PREFIX}${randomBytes(16).toString('hex')}`;
}

/**
 * @param {unknown} value
 * @returns {boolean} whether the value is an id this gateway accepts
 */
export function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value);
}
