/**
 * DeepAI account storage, allowance and the auth audit trail.
 *
 * The gateway signs in to DeepAI the same way the desktop app does and keeps
 * the resulting `api_key` in SQLite. Every sign-in, sign-out and refusal is
 * appended to `auth_events`, so an operator can see who used the gateway and
 * when.
 *
 * @module deepai-to-api/store
 */

/** Read the single account row, or undefined when signed out. */
export function readAccount(db) {
  const row = db.prepare('SELECT * FROM account WHERE id = 1').get();
  if (row === undefined) return undefined;
  return {
    apiKey: row.api_key,
    username: row.username,
    isPro: row.is_pro === 1,
    createdAt: row.created_at,
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

/** Persist a freshly signed-in account. */
export function saveAccount(db, account) {
  db.prepare(`
    INSERT INTO account (id, api_key, username, is_pro, balance, granted, refresh_at, checked_at, created_at)
    VALUES (1, ?, ?, ?, NULL, NULL, NULL, NULL, ?)
    ON CONFLICT(id) DO UPDATE SET
      api_key  = excluded.api_key,
      username = excluded.username,
      is_pro   = excluded.is_pro,
      created_at = excluded.created_at
  `).run(account.apiKey, account.username ?? '', account.isPro ? 1 : 0, Date.now());
}

/** Record the latest allowance reading. */
export function saveAllowance(db, allowance) {
  db.prepare(`
    UPDATE account
       SET balance = ?, granted = ?, refresh_at = ?, checked_at = ?
     WHERE id = 1
  `).run(
    allowance?.balance ?? null,
    allowance?.granted ?? null,
    allowance?.refreshAt ?? null,
    Date.now(),
  );
}

/** Update the cached pro flag (the entitlement endpoint can change it). */
export function savePro(db, isPro) {
  db.prepare('UPDATE account SET is_pro = ? WHERE id = 1').run(isPro ? 1 : 0);
}

/** Remove the stored account. */
export function clearAccount(db) {
  db.prepare('DELETE FROM account WHERE id = 1').run();
}

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

/** Read one gateway setting. */
export function getSetting(db, key, fallback = undefined) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row === undefined ? fallback : row.value;
}

/** Write one gateway setting. */
export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
