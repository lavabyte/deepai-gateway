/**
 * SQLite schema and migrations.
 *
 * One file holds everything the gateway persists: the DeepAI account, gateway
 * API keys (with their owner and limits), per-request usage rows, an auth
 * audit trail and a rolling settings bag. `node:sqlite` ships with Node, so
 * there is no native build step.
 *
 * @module deepai-to-api/db
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Bump when a migration below is added. */
const SCHEMA_VERSION = 3;

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

  if (current < 1) migrateToV1(db);
  if (current < 2) migrateToV2(db);
  if (current < 3) migrateToV3(db);

  if (current !== SCHEMA_VERSION) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('schema_version', String(SCHEMA_VERSION));
  }

  return db;
}

/** Initial schema: account, keys, usage, settings. */
function migrateToV1(db) {
  db.exec(`
    -- The signed-in DeepAI account. Exactly one row (id = 1).
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

/** Add a column only when the table does not already have it. */
function addColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (columns.includes(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
