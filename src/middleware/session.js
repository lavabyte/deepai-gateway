/**
 * Dashboard session handling.
 *
 * Before this existed, "who is logged in" was a single global row: every visitor
 * to the panel saw and controlled the same keys. A session cookie now ties each
 * browser to one DeepAI account, so the dashboard can answer "which account is
 * asking" instead of "is anyone logged in".
 *
 * The cookie is `HttpOnly` and `SameSite=Lax`, and only its SHA-256 hash is
 * stored, so neither a database leak nor page script can obtain a usable token.
 *
 * @module deepai-gateway/middleware/session
 */

import {
  clearSessionCookie,
  sessionAccount,
  tokenFromCookie,
  touchAccount,
} from '../store.js';

/**
 * Attach the resolved account to every request as `req.account`.
 *
 * This never rejects: routes decide for themselves whether a session is
 * required, so an anonymous visitor can still load the dashboard shell and the
 * public catalog.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function attachSession(db, options = {}) {
  return (req, res, next) => {
    const cookieHeader = req.get('cookie');
    const token = tokenFromCookie(cookieHeader);
    req.sessionToken = token;
    req.account = token === undefined ? undefined : sessionAccount(db, token);
    // Opening the dashboard is the account being used. Throttled inside `touchAccount`,
    // so this is not a write per request.
    if (req.account !== undefined) touchAccount(db, req.account.username);
    // An expired or revoked cookie is cleared so the browser stops sending it.
    if (token !== undefined && req.account === undefined) {
      res.append('set-cookie', clearSessionCookie());
    }

    next();
  };
}

/**
 * Require a session. Answers `401` with a stable code so the dashboard can show
 * a log-in prompt rather than an error.
 */
export function requireSession(req, res, next) {
  if (req.account !== undefined) return next();
  return res.status(401).json({
    ok: false,
    error: 'Log in to DeepAI to view your keys and usage.',
    code: 'not_logged_in',
  });
}

/** Shape the signed-in account for the dashboard. */
export function publicAccount(account) {
  if (account === undefined) return undefined;
  return {
    username: account.username,
    isPro: account.isPro,
    allowance: account.allowance ?? null,
    signedInSince: account.createdAt,
    sessionExpiresAt: account.sessionExpiresAt ?? null,
  };
}
