/**
 * DeepAI accounts, dashboard sessions and the auth audit trail.
 *
 * The gateway signs in to DeepAI the same way the desktop app does and keeps the
 * resulting `api_key` in SQLite — one row per DeepAI user. A browser proves its
 * identity with a session cookie whose token hash is stored here, so the
 * dashboard knows *which* account is asking instead of trusting a single global
 * row.
 *
 * Every sign-in, sign-out and refusal is appended to `auth_events`, so an
 * operator can see who used the gateway and when.
 *
 * @module deepai-gateway/store
 */

import { createHash, randomBytes } from 'node:crypto';

/** Session cookie name. */
export const SESSION_COOKIE = 'deepai_gateway_session';

/**
 * Cookie that groups one browser's login requests.
 *
 * Not a credential: it only lets the gateway tell two visitors' pending logins
 * apart. It must be a cookie rather than a header because DeepAI's callback is a
 * top-level navigation that carries cookies but no custom headers.
 */
export const LOGIN_COOKIE = 'deepai_gateway_login';

/** Lifetime of the login-grouping cookie. */
const LOGIN_COOKIE_TTL_MS = 15 * 60_000;

/** A fresh login-browser identifier. */
export function newLoginId() {
  return randomBytes(16).toString('hex');
}

/** Read the login-grouping cookie, or undefined. */
export function loginIdFromCookie(header) {
  return cookieValue(header, LOGIN_COOKIE);
}

/** Set the login-grouping cookie. `SameSite=Lax` so the callback still sends it. */
export function loginCookie(id, { secure = false } = {}) {
  const parts = [
    `${LOGIN_COOKIE}=${encodeURIComponent(id)}`,
    'Path=/',
    // Not HttpOnly: nothing secret, and the dashboard reads it to reuse the slot.
    'SameSite=Lax',
    `Max-Age=${Math.floor(LOGIN_COOKIE_TTL_MS / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Clear the login-grouping cookie. */
export function clearLoginCookie() {
  return `${LOGIN_COOKIE}=; Path=/; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

/** How long a session stays valid without being used. */
export const SESSION_TTL_MS = 14 * 24 * 60 * 60_000;

/** Number of random bytes in a session token (64 hex characters). */
const TOKEN_BYTES = 32;

/* --------------------------------------------------------------- accounts */

/** Shape one `accounts` row for callers. */
function accountOf(row) {
  if (row === undefined || row === null) return undefined;
  return {
    id: row.id,
    apiKey: row.api_key,
    username: row.username,
    isPro: row.is_pro === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    allowance: allowanceOf(row),
  };
}

/** Allowance view of one account row. */
function allowanceOf(row) {
  if (row.balance === null && row.granted === null && row.refresh_at === null) return null;
  return {
    balance: row.balance,
    granted: row.granted,
    refreshAt: row.refresh_at,
    checkedAt: row.checked_at ?? null,
  };
}

/**
 * Read one account by username.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} username
 * @returns {object|undefined}
 */
export function readAccount(db, username) {
  if (typeof username !== 'string' || username === '') return undefined;
  return accountOf(db.prepare('SELECT * FROM accounts WHERE username = ?').get(username));
}

/** Every signed-in DeepAI account. */
export function listAccounts(db) {
  return db.prepare('SELECT * FROM accounts ORDER BY created_at ASC').all().map(accountOf);
}

/**
 * Persist a freshly signed-in account.
 *
 * Username is the identity: signing in again as the same DeepAI user replaces
 * that row's key rather than adding a second row. Two different DeepAI users get
 * two rows and never see each other's keys.
 *
 * @returns {{account: object, created: boolean}}
 */
export function saveAccount(db, account) {
  const username = typeof account.username === 'string' && account.username !== ''
    ? account.username
    : `user-${hash8(account.apiKey)}`;
  const now = Date.now();
  const existing = db.prepare('SELECT id FROM accounts WHERE username = ?').get(username);

  if (existing === undefined) {
    db.prepare(`
      INSERT INTO accounts (username, api_key, is_pro, balance, granted, refresh_at, checked_at, created_at, updated_at)
      VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
    `).run(username, account.apiKey, account.isPro ? 1 : 0, now, now);
  } else {
    // The key is replaced, but the cached allowance is kept: it belongs to the
    // same DeepAI user and is still the best reading until a refresh lands.
    db.prepare(`
      UPDATE accounts
         SET api_key = ?, is_pro = ?, updated_at = ?
       WHERE username = ?
    `).run(account.apiKey, account.isPro ? 1 : 0, now, username);
  }

  return {
    account: readAccount(db, username),
    created: existing === undefined,
  };
}

/** Record the latest allowance reading for one account. */
export function saveAllowance(db, username, allowance) {
  db.prepare(`
    UPDATE accounts
       SET balance = ?, granted = ?, refresh_at = ?, checked_at = ?
     WHERE username = ?
  `).run(
    allowance?.balance ?? null,
    allowance?.granted ?? null,
    allowance?.refreshAt ?? null,
    Date.now(),
    username,
  );
}

/** Update the cached pro flag (the entitlement endpoint can change it). */
export function savePro(db, username, isPro) {
  db.prepare('UPDATE accounts SET is_pro = ? WHERE username = ?').run(isPro ? 1 : 0, username);
}

/**
 * Remove one account and everything that belongs to it.
 *
 * The DeepAI key goes with the account, because keeping a credential the user
 * asked to forget would be wrong. Keys and sessions are removed explicitly;
 * usage rows stay so aggregate history does not silently shrink.
 */
export function clearAccount(db, username) {
  db.prepare('DELETE FROM sessions WHERE account_id IN (SELECT id FROM accounts WHERE username = ?)').run(username);
  db.prepare('DELETE FROM api_keys WHERE owner_username = ?').run(username);
  db.prepare('DELETE FROM accounts WHERE username = ?').run(username);
}

/* --------------------------------------------------------------- sessions */

/** Hash a session token for storage and lookup. */
export function hashToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/**
 * Create a session for one account and return the plaintext token.
 *
 * The token is shown exactly once, in the `Set-Cookie` header. Only its hash is
 * persisted, so a database leak does not hand out dashboard access.
 *
 * @returns {{token: string, id: string, expiresAt: number}}
 */
export function createSession(db, username, { ttlMs = SESSION_TTL_MS } = {}) {
  const account = readAccount(db, username);
  if (account === undefined) throw new Error(`no such account: ${username}`);
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  const now = Date.now();
  const expiresAt = now + ttlMs;
  const id = `sess_${randomBytes(9).toString('hex')}`;
  db.prepare(`
    INSERT INTO sessions (id, token_hash, account_id, created_at, last_seen_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, hashToken(token), account.id, now, now, expiresAt);
  return { token, id, expiresAt };
}

/**
 * Resolve a session token to its account, or `undefined` when the token is
 * unknown or expired. An expired session is removed as it is encountered.
 */
export function sessionAccount(db, token, now = Date.now()) {
  if (typeof token !== 'string' || token === '') return undefined;
  const row = db.prepare(`
    SELECT s.id AS session_id, s.expires_at, s.last_seen_at, a.*
      FROM sessions s JOIN accounts a ON a.id = s.account_id
     WHERE s.token_hash = ?
  `).get(hashToken(token));
  if (row === undefined) return undefined;
  if (Number(row.expires_at) <= now) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(row.session_id);
    return undefined;
  }
  // Touch at most once a minute: this runs on every dashboard request, and the
  // exact value only matters for the idle timeout.
  if (now - Number(row.last_seen_at ?? 0) > 60_000) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now, row.session_id);
  }
  const account = accountOf(row);
  if (account !== undefined) {
    account.sessionId = row.session_id;
    account.sessionExpiresAt = Number(row.expires_at);
  }
  return account;
}

/** End one session. */
export function destroySession(db, token) {
  if (typeof token !== 'string' || token === '') return false;
  const result = db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  return Number(result.changes) > 0;
}

/** Remove expired sessions. Cheap enough to run opportunistically. */
export function pruneSessions(db, now = Date.now()) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
}

/**
 * Parse the session cookie out of a request's `Cookie` header.
 *
 * Hand-rolled rather than adding `cookie-parser`: one header, one name.
 */
export function tokenFromCookie(header) {
  return cookieValue(header, SESSION_COOKIE);
}

/**
 * Read one named cookie out of a `Cookie` header.
 *
 * An undecodable value is treated as absent, never thrown. Cookie values arrive
 * straight from the network, and `decodeURIComponent` throws on a lone `%` or a
 * malformed escape like `%ZZ`; that throw would happen inside the session
 * middleware, which runs before every route — so one bad cookie would turn every
 * response into a 500, including `/healthz`, and the browser would never be told
 * to drop it.
 */
export function cookieValue(header, name) {
  if (typeof header !== 'string' || header === '') return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    if (value === '') return undefined;
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Build the `Set-Cookie` value that stores a session token. */
export function sessionCookie(token, expiresAt, { secure = false } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Build the `Set-Cookie` value that clears the session cookie. */
export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

/* ------------------------------------------------------------- auth trail */

/**
 * Append one auth event.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {'login'|'logout'|'refresh'|'denied'} event
 * @param {{username?: string, detail?: string}} [info]
 */
export function recordAuthEvent(db, event, info = {}) {
  db.prepare('INSERT INTO auth_events (event, username, detail, created_at) VALUES (?, ?, ?, ?)')
    .run(event, info.username ?? '', info.detail ?? null, Date.now());
}

/** Recent auth events for one account, newest first. */
export function recentAuthEvents(db, limit = 25, username = undefined) {
  const rows = typeof username === 'string'
    ? db.prepare('SELECT * FROM auth_events WHERE username = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(username, limit)
    : db.prepare('SELECT * FROM auth_events ORDER BY created_at DESC, id DESC LIMIT ?').all(limit);
  return rows
    .map((row) => ({
      id: row.id,
      event: row.event,
      username: row.username,
      detail: row.detail ?? null,
      createdAt: row.created_at,
    }));
}

/* --------------------------------------------------------------- settings */

/**
 * Read one gateway setting for an account.
 *
 * Settings are per account: a default model chosen by one user must not change
 * what another user's dashboard shows.
 */
export function getSetting(db, username, key, fallback = undefined) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(settingKey(username, key));
  return row === undefined ? fallback : row.value;
}

/** Write one per-account gateway setting. */
export function setSetting(db, username, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(settingKey(username, key), String(value));
}

/** Namespace a setting key by owner, so accounts cannot overwrite each other. */
function settingKey(username, key) {
  return `${typeof username === 'string' && username !== '' ? username : '_'}:${key}`;
}

/** Short stable digest used to derive a username when DeepAI gives none. */
function hash8(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex').slice(0, 8);
}
