/**
 * API-key authentication and limit enforcement.
 *
 * A request presents its key as `Authorization: Bearer sk-…` (or `x-api-key`).
 * The middleware resolves it to a row, refuses unusable keys, enforces the
 * request/token limits inside the key's own window, and refuses models the key
 * is not allowed to use.
 *
 * @module deepai-gateway/middleware/auth
 */

import { allowsModel, hashKey, isUsable, overLimit } from '../keys.js';
import { keyUsage } from '../usage.js';
import { readAccount } from '../store.js';

/** Pull a gateway key out of the request headers. */
export function keyFromRequest(req) {
  const header = req.get('authorization');
  if (typeof header === 'string' && header !== '') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match !== null) return match[1].trim();
  }
  const direct = req.get('x-api-key');
  if (typeof direct === 'string' && direct.trim() !== '') return direct.trim();
  return undefined;
}

/** OpenAI-shaped error body. */
export function apiError(res, status, message, code, type = 'invalid_request_error') {
  return res.status(status).json({ error: { message, type, code, param: null } });
}

/**
 * Build the authentication middleware.
 *
 * The lookup and the `last_used_at` touch are prepared once and reused: on a
 * streaming hot path, re-preparing them per request costs roughly eight times
 * as much as running them.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function authenticate(db) {
  const selectKey = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?');
  const touchKey = db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?');

  return (req, res, next) => {
    const presented = keyFromRequest(req);
    if (presented === undefined) {
      return apiError(
        res,
        401,
        'Missing API key. Pass it as "Authorization: Bearer sk-…".',
        'missing_api_key',
        'authentication_error',
      );
    }
    if (!presented.startsWith('sk-')) {
      return apiError(res, 401, 'Malformed API key.', 'invalid_api_key', 'authentication_error');
    }

    const row = selectKey.get(hashKey(presented));
    if (row === undefined) {
      return apiError(res, 401, 'Unknown API key.', 'invalid_api_key', 'authentication_error');
    }
    if (!isUsable(row)) {
      const reason = row.revoked_at ? 'revoked' : 'expired';
      return apiError(res, 401, `This API key is ${reason}.`, `key_${reason}`, 'authentication_error');
    }

    const usage = keyUsage(db, row.id, row.limit_window);
    if (overLimit(row, usage)) {
      return apiError(
        res,
        429,
        `This API key reached its ${row.limit_window} limit.`,
        'key_limit_reached',
        'rate_limit_error',
      );
    }

    req.gatewayKey = row;
    req.gatewayKeyUsage = usage;
    touchKey.run(Date.now(), row.id);
    next();
  };
}

/**
 * Reject a model the key is not allowed to use. Runs after the body is parsed.
 */
export function enforceModel(req, res, next) {
  const requested = typeof req.body?.model === 'string' ? req.body.model : '';
  if (requested === '' || allowsModel(req.gatewayKey, requested)) return next();
  return apiError(
    res,
    403,
    `This API key may not use model "${requested}".`,
    'model_not_allowed',
    'permission_error',
  );
}


/**
 * Accept **either** a session or an API key on a read-only dashboard route.
 *
 * The session is already resolved by `attachSession`, so a browser needs nothing
 * extra. A script presenting one of its own `sk-` keys gets the same view, scoped
 * to that key's owner — which is what a client without a cookie needs.
 *
 * The identity is never "everything": if neither credential is present the
 * request is refused, because an unscoped usage query would expose every
 * account's traffic.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function allowKeyIdentity(db) {
  const selectKey = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?');
  const touchKey = db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?');

  return (req, res, next) => {
    // A session already won; nothing to do.
    if (req.account !== undefined) return next();

    const presented = keyFromRequest(req);
    if (presented === undefined || !presented.startsWith('sk-')) {
      return apiError(
        res,
        401,
        'Provide a session cookie or an API key ("Authorization: Bearer sk-…").',
        'missing_credentials',
        'authentication_error',
      );
    }

    const row = selectKey.get(hashKey(presented));
    if (row === undefined) {
      return apiError(res, 401, 'Unknown API key.', 'invalid_api_key', 'authentication_error');
    }
    if (!isUsable(row)) {
      const reason = row.revoked_at ? 'revoked' : 'expired';
      return apiError(res, 401, `This API key is ${reason}.`, `key_${reason}`, 'authentication_error');
    }

    const account = readAccount(db, row.owner_username ?? '');
    if (account === undefined) {
      return apiError(
        res,
        503,
        'The DeepAI account that owns this API key is not signed in.',
        'deepai_signed_out',
        'api_error',
      );
    }

    req.gatewayKey = row;
    req.account = account;
    touchKey.run(Date.now(), row.id);
    next();
  };
}
