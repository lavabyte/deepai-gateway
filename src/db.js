/**
 * SQLite schema and migrations.
 *
 * One file holds everything the gateway persists: the DeepAI accounts (one row
 * per signed-in DeepAI user), dashboard sessions, gateway API keys (each bound
 * to the account that pays for it), per-request usage rows, an auth audit trail
 * and a rolling settings bag. `node:sqlite` ships with Node, so there is no
 * native build step.
 *
 * @module deepai-gateway/db
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Current schema version. Bump when a migration below is added. */
export const SCHEMA_VERSION = 5;

/**
 * Open (creating if needed) the database at `file` and bring it to the current
 * schema. Safe to call repeatedly and on an existing older database.
 *
 * @param {string} file - absolute path, or `:memory:` in tests.
 * @returns {DatabaseSync}
 */
export function openDatabase(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const current = Number(
    db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')?.value ?? 0,
  );

  /*
   * A database written by a newer build must never be stamped down to this
   * one's version. The migrations below are one-way, and at least one is
   * destructive (v5 deletes rows), so re-running them against an already
   * migrated schema could delete data. Refuse rather than guess.
   */
  if (current > SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `database schema is v${current}, but this build understands v${SCHEMA_VERSION}. `
      + 'Upgrade the gateway, or restore a backup taken with this version.',
    );
  }

  if (current < 1) migrateToV1(db);
  if (current < 2) migrateToV2(db);
  if (current < 3) migrateToV3(db);
  if (current < 4) migrateToV4(db);
  if (current < 5) migrateToV5(db);

  // Only ever move forwards.
  if (current < SCHEMA_VERSION) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('schema_version', String(SCHEMA_VERSION));
  }

  return db;
}

/** Initial schema: account, keys, usage, settings. */
function migrateToV1(db) {
  db.exec(`
    -- The signed-in DeepAI account. Exactly one row (id = 1).
    -- Superseded by "accounts" in v4, which copies any row across and then
    -- drops this table.
    CREATE TABLE IF NOT EXISTS account (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      api_key    TEXT NOT NULL,
      username   TEXT NOT NULL DEFAULT '',
      is_pro     INTEGER NOT NULL DEFAULT 0,
      balance    TEXT,
      granted    TEXT,
      refresh_at TEXT,
      checked_at INTEGER,
      created_at INTEGER NOT NULL
    );

    -- Gateway keys. Only a hash is stored; the plaintext is shown once.
    CREATE TABLE IF NOT EXISTS api_keys (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      prefix        TEXT NOT NULL,
      key_hash      TEXT NOT NULL UNIQUE,
      created_at    INTEGER NOT NULL,
      last_used_at  INTEGER,
      revoked_at    INTEGER,
      expires_at    INTEGER,              -- NULL = never
      limit_tokens  INTEGER,              -- NULL = unlimited
      limit_requests INTEGER,             -- NULL = unlimited
      limit_window  TEXT NOT NULL DEFAULT 'month',   -- month | day | total
      allowed_models TEXT NOT NULL DEFAULT '[]'      -- JSON array; [] = all
    );
    CREATE INDEX IF NOT EXISTS api_keys_hash ON api_keys (key_hash);

    -- One row per completed (or failed) proxied request.
    CREATE TABLE IF NOT EXISTS usage (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      key_id            TEXT REFERENCES api_keys (id) ON DELETE SET NULL,
      key_name          TEXT NOT NULL DEFAULT '',
      model             TEXT NOT NULL,
      requested_model   TEXT NOT NULL DEFAULT '',
      endpoint          TEXT NOT NULL DEFAULT 'chat.completions',
      status            INTEGER NOT NULL DEFAULT 200,
      ok                INTEGER NOT NULL DEFAULT 1,
      input_tokens      INTEGER NOT NULL DEFAULT 0,
      output_tokens     INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens  INTEGER NOT NULL DEFAULT 0,
      total_tokens      INTEGER NOT NULL DEFAULT 0,
      duration_ms       INTEGER NOT NULL DEFAULT 0,
      first_token_ms    INTEGER,
      streamed          INTEGER NOT NULL DEFAULT 0,
      error_code        TEXT,
      created_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS usage_created ON usage (created_at);
    CREATE INDEX IF NOT EXISTS usage_key ON usage (key_id, created_at);
    CREATE INDEX IF NOT EXISTS usage_model ON usage (model, created_at);

    -- Gateway settings that are not the account (e.g. default model).
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

/**
 * v2 — ownership and unambiguous model restriction.
 *
 * - `owner_username` / `owner_key_hash` record which DeepAI account a gateway
 *   key bills to, so usage can be attributed to a person.
 * - `models_restricted` separates "no restriction" from "nothing allowed":
 *   before this, an empty `allowed_models` meant "every model", which made an
 *   empty selection indistinguishable from an explicit allow-all.
 * - `auth_events` is an append-only audit trail of sign-in and sign-out.
 */
function migrateToV2(db) {
  addColumn(db, 'api_keys', 'owner_username', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'api_keys', 'owner_key_hash', 'TEXT');
  addColumn(db, 'api_keys', 'models_restricted', 'INTEGER NOT NULL DEFAULT 0');

  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      event      TEXT NOT NULL,              -- login | logout | refresh | denied
      username   TEXT NOT NULL DEFAULT '',
      detail     TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_events_created ON auth_events (created_at);
  `);

  // Existing rows predate ownership: attribute them to the current account.
  const account = db.prepare('SELECT username FROM account WHERE id = 1').get();
  if (account?.username) {
    db.prepare("UPDATE api_keys SET owner_username = ? WHERE owner_username = ''").run(account.username);
  }
}

/**
 * v3 — per-user isolation.
 *
 * - `usage.owner_username` carries the owner on the row itself, so usage stays
 *   attributable after the key that produced it is deleted (`key_id` becomes
 *   NULL and `key_name` is only a label).
 * - `api_keys.owner_username` is indexed, because every dashboard query now
 *   filters on it.
 */
function migrateToV3(db) {
  addColumn(db, 'usage', 'owner_username', "TEXT NOT NULL DEFAULT ''");

  // Backfill from the key that produced each row where the key still exists.
  db.exec(`
    UPDATE usage
       SET owner_username = COALESCE(
             (SELECT owner_username FROM api_keys WHERE api_keys.id = usage.key_id),
             ''
           )
     WHERE owner_username = ''
  `);

  // Rows whose key is already gone cannot be attributed; leave them empty
  // rather than guessing, and they are only visible to an operator.
  db.exec('CREATE INDEX IF NOT EXISTS usage_owner ON usage (owner_username, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS api_keys_owner ON api_keys (owner_username)');
}

/**
 * v4 — real multi-user.
 *
 * Before this the gateway had exactly one DeepAI account (`CHECK (id = 1)`) and
 * no dashboard session at all, so "per user" only ever meant "per key": every
 * visitor to the panel controlled the same keys and every key billed the same
 * account.
 *
 * - `accounts` holds **one row per DeepAI login**, keyed by username. Any
 *   pre-existing single row is copied across before the old table is dropped.
 * - `sessions` gives each browser its own identity. Only the token hash is
 *   stored, so a database leak does not hand out dashboard access.
 * - A key stays bound to the account that created it through
 *   `api_keys.owner_username`, which is now a real foreign key rather than a
 *   copied label.
 */
function migrateToV4(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT NOT NULL UNIQUE,
      api_key     TEXT NOT NULL,
      is_pro      INTEGER NOT NULL DEFAULT 0,
      balance     TEXT,
      granted     TEXT,
      refresh_at  TEXT,
      checked_at  INTEGER,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    -- One browser session. Only the token hash is stored.
    CREATE TABLE IF NOT EXISTS sessions (
      id           TEXT PRIMARY KEY,
      token_hash   TEXT NOT NULL UNIQUE,
      account_id   INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
      created_at   INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_account ON sessions (account_id);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);
  `);

  // Carry the pre-v4 account across, if there is one.
  const legacy = db.prepare('SELECT * FROM account WHERE id = 1').get();
  if (legacy !== undefined && typeof legacy.api_key === 'string' && legacy.api_key !== '') {
    const username = typeof legacy.username === 'string' && legacy.username !== ''
      ? legacy.username
      : `user-${hash8(legacy.api_key)}`;
    const now = Date.now();
    db.prepare(`
      INSERT INTO accounts (username, api_key, is_pro, balance, granted, refresh_at, checked_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        api_key    = excluded.api_key,
        is_pro     = excluded.is_pro,
        updated_at = excluded.updated_at
    `).run(
      username,
      legacy.api_key,
      legacy.is_pro ?? 0,
      legacy.balance ?? null,
      legacy.granted ?? null,
      legacy.refresh_at ?? null,
      legacy.checked_at ?? null,
      legacy.created_at ?? now,
      now,
    );
  }

  db.exec('DROP TABLE IF EXISTS account');

  // Exactly one account and unowned keys: bind them, since there is no ambiguity
  // about who paid for them.
  const accounts = db.prepare('SELECT id, username FROM accounts').all();
  if (accounts.length === 1) {
    db.prepare("UPDATE api_keys SET owner_username = ? WHERE owner_username = '' OR owner_username IS NULL")
      .run(accounts[0].username);
  }
}

/**
 * v5 — revoking a key now deletes it.
 *
 * Revoking used to keep the row as a restorable tombstone. That left two ways to
 * end a key (revoke, then a separate remove) describing nearly the same thing,
 * and the tombstones accumulated in the list. Revoke is the single destructive
 * action now, so any tombstone from the old behaviour is cleared here.
 *
 * Usage rows are untouched: they carry `key_name` and their `key_id` is set to
 * NULL by the foreign key, so history stays attributable to the name it had.
 */
function migrateToV5(db) {
  db.prepare('DELETE FROM api_keys WHERE revoked_at IS NOT NULL').run();
  // The index is part of the schema, so it is created unconditionally: gating it
  // on `changes > 0` made the schema depend on whether a deployment happened to
  // hold a tombstone, and the common upgrade path ended up without it.
  db.exec('CREATE INDEX IF NOT EXISTS api_keys_active ON api_keys (owner_username, revoked_at)');
}

/** Short stable digest used to derive a username when DeepAI gives none. */
function hash8(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 8);
}

/** Add a column only when the table does not already have it. */
function addColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (columns.includes(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
