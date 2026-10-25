/**
 * Usage recording and aggregation.
 *
 * Every proxied request appends one row. All dashboards read from that single
 * table so totals, per-model breakdowns and the recent-request list can never
 * disagree with each other.
 *
 * Token counts are stored disjoint: `input_tokens` excludes cached input,
 * matching what the gateway reports to its own clients.
 *
 * @module deepai-gateway/usage
 */

/** Start of the current day (local time) as epoch milliseconds. */
export function startOfDay(now = Date.now()) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Start of the current month (local time) as epoch milliseconds. */
export function startOfMonth(now = Date.now()) {
  const date = new Date(now);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Start of the current hour (local time) as epoch milliseconds. */
export function startOfHour(now = Date.now()) {
  const date = new Date(now);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

/** Lower bound for one limit window. `total` and `unlimited` start at the epoch. */
export function windowStart(window, now = Date.now()) {
  if (window === 'hour') return startOfHour(now);
  if (window === 'day') return startOfDay(now);
  if (window === 'month') return startOfMonth(now);
  return 0;
}

/**
 * Append one usage row.
 *
 * The insert is prepared once per database and reused: this runs on every
 * completed request, and re-preparing the statement each time is measurably
 * slower than the insert itself.
 */
const insertCache = new WeakMap();

function insertStatement(db) {
  let statement = insertCache.get(db);
  if (statement === undefined) {
    /*
     * `key_id` is resolved with a subquery rather than bound directly. A
     * completion can run for tens of seconds, and the owner may revoke the key
     * from the dashboard while it is in flight; revoking deletes the row, so a
     * bound id would fail the foreign key and the usage row would be lost — even
     * though the request was already billed upstream. A subquery that matches
     * nothing yields NULL, which the foreign key permits, so the row is kept and
     * stays attributable through `key_name` and `owner_username`.
     */
    statement = db.prepare(`
      INSERT INTO usage (
        key_id, key_name, owner_username, model, requested_model, endpoint,
        status, ok, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, reasoning_tokens, total_tokens, duration_ms,
        first_token_ms, streamed, error_code, created_at
      ) VALUES (
        (SELECT id FROM api_keys WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);
    insertCache.set(db, statement);
  }
  return statement;
}

export function record(db, entry) {
  insertStatement(db).run(
    entry.keyId ?? null,
    entry.keyName ?? '',
    entry.owner ?? '',
    entry.model ?? '',
    entry.requestedModel ?? '',
    entry.endpoint ?? 'chat.completions',
    entry.status ?? 200,
    entry.ok === false ? 0 : 1,
    entry.inputTokens ?? 0,
    entry.outputTokens ?? 0,
    entry.cacheReadTokens ?? 0,
    entry.cacheWriteTokens ?? 0,
    entry.reasoningTokens ?? 0,
    entry.totalTokens ?? 0,
    entry.durationMs ?? 0,
    entry.firstTokenMs ?? null,
    entry.streamed ? 1 : 0,
    entry.errorCode ?? null,
    entry.createdAt ?? Date.now(),
  );
}

/**
 * Build a `WHERE` fragment scoping a query to one owner.
 *
 * The dashboard is per user: a signed-in account only ever sees its own keys
 * and its own traffic. `owner === undefined` means "no owner filter", which is
 * only used by internal callers.
 *
 * @param {string|undefined} owner
 * @returns {{sql: string, params: Array<string>}}
 */
function ownerScope(owner) {
  if (typeof owner !== 'string') return { sql: '', params: [] };
  return { sql: ' AND owner_username = ?', params: [owner] };
}

/** Totals for one time range, scoped to an owner. */
export function totals(db, since = 0, owner = undefined) {
  const scope = ownerScope(owner);
  const row = db.prepare(`
    SELECT
      COUNT(*)                        AS requests,
      COALESCE(SUM(ok), 0)            AS ok_requests,
      COALESCE(SUM(total_tokens), 0)  AS total_tokens,
      COALESCE(SUM(input_tokens), 0)  AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_tokens), 0)  AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
      COALESCE(SUM(reasoning_tokens), 0)   AS reasoning_tokens,
      COALESCE(AVG(NULLIF(duration_ms, 0)), 0) AS avg_duration_ms
    FROM usage
    WHERE created_at >= ?${scope.sql}
  `).get(since, ...scope.params);
  return {
    requests: Number(row.requests),
    okRequests: Number(row.ok_requests),
    failedRequests: Number(row.requests) - Number(row.ok_requests),
    totalTokens: Number(row.total_tokens),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    cacheReadTokens: Number(row.cache_read_tokens),
    cacheWriteTokens: Number(row.cache_write_tokens),
    reasoningTokens: Number(row.reasoning_tokens),
    avgDurationMs: Math.round(Number(row.avg_duration_ms)),
  };
}

/**
 * Per-model totals for one time range, busiest first. Models with no usage are
 * simply absent, which is what lets the dashboard hide them.
 */
export function byModel(db, since = 0, owner = undefined) {
  const scope = ownerScope(owner);
  return db.prepare(`
    SELECT
      model,
      COUNT(*)                       AS requests,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
      MAX(created_at)                AS last_used_at
    FROM usage
    WHERE created_at >= ?${scope.sql}
    GROUP BY model
    ORDER BY total_tokens DESC, requests DESC
  `).all(since, ...scope.params).map((row) => ({
    model: row.model,
    requests: Number(row.requests),
    totalTokens: Number(row.total_tokens),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    reasoningTokens: Number(row.reasoning_tokens),
    cacheReadTokens: Number(row.cache_read_tokens),
    lastUsedAt: Number(row.last_used_at),
  }));
}

/** Daily token series for the last `days` days, oldest first. */
export function daily(db, days = 14, now = Date.now(), owner = undefined) {
  const buckets = [];
  const cursor = new Date(startOfDay(now));
  for (let index = days - 1; index >= 0; index -= 1) {
    const day = new Date(cursor);
    day.setDate(day.getDate() - index);
    buckets.push({ date: day.getTime(), label: isoDay(day), tokens: 0, requests: 0 });
  }
  const oldest = buckets[0].date;
  const scope = ownerScope(owner);
  for (const row of db.prepare(`
    SELECT created_at, total_tokens FROM usage WHERE created_at >= ?${scope.sql}
  `).all(oldest, ...scope.params)) {
    const key = isoDay(new Date(startOfDay(Number(row.created_at))));
    const bucket = buckets.find((item) => item.label === key);
    if (bucket === undefined) continue;
    bucket.tokens += Number(row.total_tokens);
    bucket.requests += 1;
  }
  return buckets;
}

/** `YYYY-MM-DD` in local time. */
function isoDay(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Most recent requests, newest first. */
export function recent(db, limit = 25, keyId = undefined, owner = undefined) {
  const clauses = [];
  const params = [];
  if (keyId !== undefined) {
    clauses.push('key_id = ?');
    params.push(keyId);
  }
  if (typeof owner === 'string') {
    clauses.push('owner_username = ?');
    params.push(owner);
  }
  const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
  const rows = db.prepare(`SELECT * FROM usage${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...params, limit);
  return rows.map(publicUsage);
}

/**
 * Every usage row in a range, oldest first, for export.
 *
 * Rows are streamed through an iterator so exporting a large history does not
 * materialise it all at once.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{since?: number, until?: number, keyId?: string}} [filter]
 * @returns {IterableIterator<object>}
 */
export function* exportRows(db, filter = {}) {
  const clauses = [];
  const params = [];
  if (typeof filter.owner === 'string') {
    clauses.push('owner_username = ?');
    params.push(filter.owner);
  }
  if (Number.isFinite(filter.since)) {
    clauses.push('created_at >= ?');
    params.push(filter.since);
  }
  if (Number.isFinite(filter.until)) {
    clauses.push('created_at <= ?');
    params.push(filter.until);
  }
  if (typeof filter.keyId === 'string' && filter.keyId !== '') {
    clauses.push('key_id = ?');
    params.push(filter.keyId);
  }
  const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
  const statement = db.prepare(`SELECT * FROM usage${where} ORDER BY created_at ASC, id ASC`);
  for (const row of statement.iterate(...params)) yield row;
}

/** CSV header matching {@link exportCsvRow}. */
export const CSV_COLUMNS = Object.freeze([
  'id', 'created_at', 'key_id', 'key_name', 'owner_username', 'model', 'requested_model', 'endpoint',
  'status', 'ok', 'input_tokens', 'output_tokens', 'cache_read_tokens',
  'cache_write_tokens', 'reasoning_tokens', 'total_tokens', 'duration_ms',
  'first_token_ms', 'streamed', 'error_code',
]);

/** Quote one CSV field. */
function csvField(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One usage row as a CSV line. */
export function exportCsvRow(row) {
  return CSV_COLUMNS.map((column) => csvField(row[column])).join(',');
}

/** One usage row as a flat JSON object for export. */
export function exportJsonRow(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    createdAtIso: new Date(Number(row.created_at)).toISOString(),
    keyId: row.key_id ?? null,
    keyName: row.key_name,
    owner: row.owner_username ?? '',
    model: row.model,
    requestedModel: row.requested_model,
    endpoint: row.endpoint,
    status: row.status,
    ok: row.ok === 1,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    reasoningTokens: row.reasoning_tokens,
    totalTokens: row.total_tokens,
    durationMs: row.duration_ms,
    firstTokenMs: row.first_token_ms ?? null,
    streamed: row.streamed === 1,
    errorCode: row.error_code ?? null,
  };
}

/** One usage row as sent to the browser. */
export function publicUsage(row) {
  return {
    id: row.id,
    keyId: row.key_id ?? null,
    keyName: row.key_name,
    owner: row.owner_username ?? '',
    model: row.model,
    requestedModel: row.requested_model,
    endpoint: row.endpoint,
    status: row.status,
    ok: row.ok === 1,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    reasoningTokens: row.reasoning_tokens,
    totalTokens: row.total_tokens,
    durationMs: row.duration_ms,
    firstTokenMs: row.first_token_ms ?? null,
    streamed: row.streamed === 1,
    errorCode: row.error_code ?? null,
    createdAt: row.created_at,
  };
}

/** Totals for one key inside its own limit window. */
export function keyUsage(db, keyId, window) {
  const since = windowStart(window);
  /*
   * Every attempt counts, successful or not.
   *
   * This deliberately includes failures, because a failed request has already
   * passed the gateway and reached DeepAI: it consumed the owner's upstream
   * capacity and may have been billed for partial work. Counting only successes
   * would let a caller that keeps triggering upstream errors issue unlimited
   * requests — exactly the abuse the request limit exists to bound. An upstream
   * outage burning a key's allowance is the honest reading of "this key made N
   * requests", and `ok` is still recorded per row for anyone analysing failures.
   */
  const row = db.prepare(`
    SELECT COUNT(*) AS requests, COALESCE(SUM(total_tokens), 0) AS total_tokens
      FROM usage WHERE key_id = ? AND created_at >= ?
  `).get(keyId, since);
  return {
    requests: Number(row.requests),
    totalTokens: Number(row.total_tokens),
    since,
    window,
  };
}

/** Aggregate counters for the dashboard header. */
export function summary(db, now = Date.now(), owner = undefined) {
  const today = totals(db, startOfDay(now), owner);
  const month = totals(db, startOfMonth(now), owner);
  const all = totals(db, 0, owner);
  return {
    today,
    month,
    all,
    daily: daily(db, 14, now, owner),
    modelsToday: byModel(db, startOfDay(now), owner),
    modelsMonth: byModel(db, startOfMonth(now), owner),
    modelsAll: byModel(db, 0, owner),
  };
}
