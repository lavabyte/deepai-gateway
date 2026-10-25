/**
 * Gateway API keys.
 *
 * A key is shown exactly once, at creation. Only a SHA-256 hash is persisted,
 * so a database leak does not hand out working credentials. Keys look like
 * `sk-` plus 40 hex characters.
 *
 * Every key is owned by the DeepAI account that was signed in when it was
 * created, so usage can be attributed to a person.
 *
 * @module deepai-gateway/keys
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Prefix every gateway key carries. */
export const KEY_PREFIX = 'sk-';

/** Number of random bytes behind a key (40 hex characters). */
const KEY_BYTES = 20;

/**
 * Hard cap on live keys per account.
 *
 * Revoking deletes the key, so this is simply the number of rows an account may
 * hold; there is no separate tombstone population.
 */
export const MAX_KEYS = 5;

/**
 * Limit windows a key may be created with.
 *
 * `unlimited` means no token or request cap at all; `total` means a cap that
 * never resets. The rest are rolling calendar windows.
 */
export const WINDOWS = Object.freeze(['unlimited', 'hour', 'day', 'month', 'total']);

/** Hash a plaintext key for storage and lookup. */
export function hashKey(plaintext) {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/** Generate a new key; returns the plaintext plus its storable parts. */
export function generateKey() {
  const plaintext = `${KEY_PREFIX}${randomBytes(KEY_BYTES).toString('hex')}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, 11),
    hash: hashKey(plaintext),
  };
}

/** Row shape sent to the browser: never includes the hash or the plaintext. */
export function publicKey(row, usage = undefined) {
  const allowed = parseModels(row.allowed_models);
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    owner: row.owner_username ?? '',
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? null,
    revokedAt: row.revoked_at ?? null,
    expiresAt: row.expires_at ?? null,
    limitTokens: row.limit_tokens ?? null,
    limitRequests: row.limit_requests ?? null,
    limitWindow: row.limit_window,
    allowedModels: allowed,
    modelsRestricted: row.models_restricted === 1,
    status: statusOf(row, usage),
    ...(usage === undefined ? {} : { usage }),
  };
}

/** Parse the stored allowed-model JSON, tolerating junk. */
export function parseModels(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** Whether a key is usable right now, ignoring limits. */
export function isUsable(row, now = Date.now()) {
  if (row.revoked_at !== null && row.revoked_at !== undefined) return false;
  if (row.expires_at !== null && row.expires_at !== undefined && row.expires_at <= now) return false;
  return true;
}

/**
 * Whether a key may use a model.
 *
 * An unrestricted key may use everything. A restricted key may use exactly the
 * models in its list — so a restricted key with an empty list can use nothing,
 * which is what makes "no models selected" a real choice.
 */
export function allowsModel(row, modelId) {
  if (row.models_restricted !== 1) return true;
  return parseModels(row.allowed_models).includes(modelId);
}

/** Short human status for the key list. */
export function statusOf(row, usage) {
  const now = Date.now();
  if (row.revoked_at) return 'revoked';
  if (row.expires_at && row.expires_at <= now) return 'expired';
  if (usage !== undefined && overLimit(row, usage)) return 'limited';
  return 'active';
}

/** Whether the recorded usage already meets a key's limits. */
export function overLimit(row, usage) {
  const requests = Number(usage?.requests ?? 0);
  const tokens = Number(usage?.totalTokens ?? 0);
  if (row.limit_requests !== null && row.limit_requests !== undefined && requests >= row.limit_requests) {
    return true;
  }
  if (row.limit_tokens !== null && row.limit_tokens !== undefined && tokens >= row.limit_tokens) {
    return true;
  }
  return false;
}

/**
 * Constant-time comparison of two hex hashes of equal length. Returns false on
 * any length mismatch rather than throwing.
 */
export function hashesEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * How many more keys one account may create.
 *
 * The cap is per user, not global: one account filling its slots must not stop
 * another account from creating its own. Revoking deletes a key, so the count is
 * just the number of rows the account holds.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} [owner] - omit for a global count (operator view only).
 * @returns {{used: number, max: number, remaining: number, atLimit: boolean}}
 */
export function keyQuota(db, owner = undefined) {
  const scoped = typeof owner === 'string' && owner !== '';
  const used = Number(
    db.prepare(
      scoped
        ? 'SELECT COUNT(*) AS n FROM api_keys WHERE owner_username = ?'
        : 'SELECT COUNT(*) AS n FROM api_keys',
    ).get(...(scoped ? [owner] : [])).n,
  );
  return { used, max: MAX_KEYS, remaining: Math.max(0, MAX_KEYS - used), atLimit: used >= MAX_KEYS };
}
