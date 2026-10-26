#!/usr/bin/env node
/**
 * Take a consistent, self-contained backup of the gateway database.
 *
 * A plain `cp data/deepai.db` is **not** a safe backup: the database runs in WAL
 * mode, so recently committed rows live in `deepai.db-wal` until a checkpoint
 * folds them in. Copying only the `.db` file silently captures stale state —
 * verified: a key renamed in the live database was still under its old name in
 * such a copy.
 *
 * `VACUUM INTO` writes a complete, checkpointed copy without blocking writers,
 * and refuses to overwrite an existing file, so a backup can never clobber an
 * earlier one.
 *
 * Usage:
 *   node scripts/backup.js [--out DIR] [--keep N]
 *
 * Defaults: writes to `backups/` and keeps the 20 newest files.
 */

import { DatabaseSync } from 'node:sqlite';
import {
  chmodSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/** Parse `--flag value` pairs. */
function parseArgs(argv) {
  const out = { out: join(ROOT, 'backups'), keep: 20 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === '--out' && next !== undefined) {
      out.out = resolve(next);
      index += 1;
    } else if (flag === '--keep' && next !== undefined) {
      const keep = Number(next);
      if (!Number.isSafeInteger(keep) || keep < 1) throw new Error('--keep must be a positive integer');
      out.keep = keep;
      index += 1;
    } else if (flag === '--help' || flag === '-h') {
      out.help = true;
    } else {
      throw new Error(`unrecognised argument: ${flag}`);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help === true) {
  console.log('usage: node scripts/backup.js [--out DIR] [--keep N]');
  process.exit(0);
}

const source = process.env.DATABASE ?? join(ROOT, 'data', 'deepai.db');
if (!statSync(source, { throwIfNoEntry: false })?.isFile()) {
  console.error(`no database at ${source}`);
  process.exit(1);
}

mkdirSync(args.out, { recursive: true });

/** `20261025-214900`, local time, so names sort chronologically. */
function stamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate()), '-',
    pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds()),
  ].join('');
}

const target = join(args.out, `deepai-${stamp()}.db`);

// Refuse to overwrite: two backups in the same second must not lose one.
if (statSync(target, { throwIfNoEntry: false }) !== undefined) {
  console.error(`refusing to overwrite ${target}`);
  process.exit(1);
}

const db = new DatabaseSync(source);
try {
  // `VACUUM INTO` produces a complete, checkpointed copy. The path is a SQL
  // string literal, so a quote in it must be doubled rather than interpolated
  // blindly.
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  // The copy holds every account's DeepAI key, so it gets the same owner-only mode as the
  // database it came from.
  try {
    chmodSync(target, 0o600);
  } catch {
    /* a filesystem without modes */
  }
} finally {
  db.close();
}

// Report what the backup actually holds, so an empty or partial copy is obvious.
const copy = new DatabaseSync(target);
const counts = {
  accounts: copy.prepare('SELECT COUNT(*) AS n FROM accounts').get().n,
  keys: copy.prepare('SELECT COUNT(*) AS n FROM api_keys').get().n,
  usage: copy.prepare('SELECT COUNT(*) AS n FROM usage').get().n,
  sessions: copy.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,
  schema: copy.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? 'unknown',
};
copy.close();

console.log(`backup written: ${target}`);
console.log(`  schema ${counts.schema} · ${counts.accounts} account(s) · ${counts.keys} key(s) · ${counts.usage} usage row(s) · ${counts.sessions} session(s)`);

// Trim the oldest backups.
const files = readdirSync(args.out)
  .filter((name) => /^deepai-\d{8}-\d{6}\.db$/.test(name))
  .sort();
for (const name of files.slice(0, Math.max(0, files.length - args.keep))) {
  rmSync(join(args.out, name), { force: true });
  console.log(`  removed old backup: ${name}`);
}
