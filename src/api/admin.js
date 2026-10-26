/**
 * Dashboard API: account, keys, usage, models and the auth audit trail.
 *
 * Everything here is scoped to the **session's account**. A browser presents a
 * session cookie; the account that cookie resolves to owns the keys and usage
 * this router will show and change. Two accounts signed in on two browsers never
 * see each other's rows.
 *
 * Keys are created here and the plaintext is returned exactly once.
 *
 * @module deepai-gateway/api/admin
 */

import express from 'express';
import { randomUUID } from 'node:crypto';
import {
  checkKey,
  checkPastedKey,
  parseAccountPaste,
  usernameForKey,
} from '../deepai/account.js';
import { loadCatalog, publicModel } from '../deepai/catalog.js';
import {
  MAX_KEYS,
  WINDOWS,
  generateKey,
  hashKey,
  keyQuota,
  publicKey,
} from '../keys.js';
import {
  accountForApiKey,
  clearAccount,
  clearSessionCookie,
  createSession,
  destroySession,
  getSetting,
  pruneSessions,
  recentAuthEvents,
  recordAuthEvent,
  readAccount,
  saveAccount,
  saveAllowance,
  savePro,
  sessionCookie,
  setSetting,
} from '../store.js';
import { requireSession, publicAccount } from '../middleware/session.js';
import { allowKeyIdentity } from '../middleware/auth.js';
import {
  estimateSavings,
  pricingStatus,
  publicPrices,
  refreshPrices,
} from '../pricing.js';
import {
  CSV_COLUMNS,
  byModel,
  exportCsvRow,
  exportJsonRow,
  exportRows,
  keyUsage,
  recent,
  startOfDay,
  startOfMonth,
  summary,
} from '../usage.js';

/**
 * What each sign-in failure says to the visitor.
 *
 * These are the reasons the paste parser and the key check can report, and no others.
 * A separate table from any protocol vocabulary because these are read by someone
 * looking at a page, not at a response: each says what happened and what to do next.
 * The `not-for-code` case is the one worth the words — `deepai.org` issues a key for
 * the public model API, and it is not automatically enabled for DeepAI Code, so
 * "wrong key" would send the visitor looking for a mistake they did not make.
 */
const KEY_LOGIN_FAILURES = {
  empty: [400, 'Paste what your browser console printed first.'],
  'too-long': [400, 'That is far longer than the account details DeepAI sends, so something else must have been pasted.'],
  'not-json': [400, 'That is not the console output. Copy everything it printed, starting with “{”.'],
  'no-key': [400, 'That output has no API key in it. Sign in at deepai.org in the same browser, then run the command again.'],
  rejected: [401, 'DeepAI did not recognise that key. Copy it again from your DeepAI profile.'],
  'not-for-code': [
    403,
    'That key works for the DeepAI model API, but it is not enabled for DeepAI Code, which is what this gateway uses. Use the key the DeepAI Code app shows, or log in with DeepAI instead.',
  ],
  unreachable: [502, 'Could not reach DeepAI to check that key. Try again in a moment.'],
};

/**
 * Mount the dashboard API.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} runtime - logging, trust-proxy and cookie settings.
 * @returns {import('express').Router}
 */
export function adminRouter(db, runtime) {
  const router = express.Router();

  /** The session's account, or `undefined` after answering 401. */
  function requireAccount(req, res) {
    if (req.account !== undefined) return req.account;
    res.status(401).json({
      ok: false,
      error: 'Log in to DeepAI to view your keys and usage.',
      code: 'not_logged_in',
    });
    return undefined;
  }

  /**
   * Resolve a key the session's account owns. Answers 404 for another account's
   * key, so the response does not reveal that it exists.
   */
  function ownedKey(req, res) {
    const account = requireAccount(req, res);
    if (account === undefined) return undefined;
    const row = db.prepare('SELECT * FROM api_keys WHERE id = ? AND owner_username = ?')
      .get(req.params.id, account.username);
    if (row === undefined) {
      res.status(404).json({ ok: false, error: 'No such key.' });
      return undefined;
    }
    return row;
  }

  /* ---------------------------------------------------------------- account */

  router.get('/account', (req, res) => {
    const account = req.account;
    const view = publicAccount(account);
    res.json({
      signedIn: account !== undefined,
      username: view?.username ?? '',
      // The name to show: the email given at key sign-in, or the DeepAI username
      // the browser sign-in returned. Never the owner fingerprint unless there is
      // nothing else.
      displayName: account === undefined ? '' : getSetting(db, account.username, 'display_name', ''),
      isPro: view?.isPro ?? false,
      allowance: view?.allowance ?? null,
      signedInSince: view?.signedInSince ?? null,
      sessionExpiresAt: view?.sessionExpiresAt ?? null,
      defaultModel: account === undefined
        ? 'glm-5.3-flash'
        : getSetting(db, account.username, 'default_model', 'glm-5.3-flash'),
      balanceLow: isBalanceLow(account?.allowance),
      // An anonymous caller gets an empty quota, never the deployment-wide
      // count: `keyQuota(db, undefined)` would total every account's keys.
      keyQuota: account === undefined
        ? { used: 0, max: MAX_KEYS, remaining: MAX_KEYS, atLimit: false }
        : keyQuota(db, account.username),
    });
  });

  router.get('/account/events', requireSession, (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 200);
    res.json({ events: recentAuthEvents(db, limit, req.account.username) });
  });

  /**
   * Turn a DeepAI key into a session.
   *
   * The key arrives inside the account JSON its owner copied out of their browser, so
   * DeepAI has already issued it; this validates it, resolves the owner and mints the
   * cookie.
   *
   * @param {import('express').Response} res
   * @param {{key: string, displayName?: string}} input
   * @returns {Promise<void>} always sends the response.
   */
  const signInWithKey = async (res, { key, displayName }) => {
    let check;
    try {
      check = await checkPastedKey(key, AbortSignal.timeout(20_000));
    } catch (error) {
      runtime.log?.(`key sign-in failed: ${error?.message ?? error}`);
      check = { ok: false, reason: 'unreachable' };
    }

    if (check.ok !== true) {
      const [status, message] = KEY_LOGIN_FAILURES[check.reason] ?? [400, 'That key could not be used.'];
      runtime.log?.(`key sign-in refused: ${check.reason}`);
      return res.status(status).json({ ok: false, error: message, code: check.reason });
    }

    // A key DeepAI has already issued for an account keeps that account, so the same
    // key arriving twice does not split one DeepAI account across two owners. Only a
    // key never seen before gets a derived owner — which is what keeps a name from
    // claiming somebody else's account.
    const known = accountForApiKey(db, key);
    const username = known?.username ?? usernameForKey(key);
    const completed = completeLogin(db, runtime, {
      apiKey: key,
      username,
      isPro: check.isPro,
    }, { secure: runtime.trustProxy === true });

    // The name to show, kept as a setting so `accounts.username` stays the derived
    // owner it has to be.
    if (typeof displayName === 'string' && displayName !== '') {
      setSetting(db, username, 'display_name', displayName);
    }

    // Persist the allowance just read, so the badge shows a balance immediately
    // rather than waiting for the background refresh.
    saveAllowance(db, username, check.allowance);
    if (typeof check.isPro === 'boolean') savePro(db, username, check.isPro);

    res.setHeader('set-cookie', completed.cookie);
    return res.json({ ok: true, username: completed.username, created: completed.created });
  };

  /**
   * Sign in with the account details copied out of the visitor's own browser.
   *
   * The one route that works for a Google or Apple account without a tunnel: their
   * sign-in happens in their browser as usual, and the console command hands back the
   * account JSON DeepAI itself produced — which carries both the API key and the
   * account's own email. Nothing is typed from memory and nothing has to be trusted
   * but the key, which DeepAI validates.
   */
  router.post('/login/profile', async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    const parsed = parseAccountPaste(text);
    if (parsed.ok !== true) {
      const [status, message] = KEY_LOGIN_FAILURES[parsed.reason] ?? [400, 'That could not be read.'];
      runtime.log?.(`profile sign-in refused: ${parsed.reason}`);
      return res.status(status).json({ ok: false, error: message, code: parsed.reason });
    }
    return signInWithKey(res, { key: parsed.apiKey, displayName: parsed.email });
  });

  /**
   * Log out of **this browser only**.
   *
   * The session is destroyed, so this tab forgets who it was. The DeepAI account
   * and its keys are left alone: another signed-in browser keeps working, and
   * signing in again from here restores the same keys.
   */
  router.post('/logout', (req, res) => {
    const account = req.account;
    if (req.sessionToken !== undefined) destroySession(db, req.sessionToken);
    if (account !== undefined) {
      recordAuthEvent(db, 'logout', { username: account.username, detail: 'session ended' });
      runtime.log?.(`logged out ${account.username}`);
    }
    res.setHeader('set-cookie', clearSessionCookie());
    res.json({ ok: true });
  });

  /** Forget the account entirely, including its DeepAI key and API keys. */
  router.post('/account/forget', requireSession, (req, res) => {
    const username = req.account.username;
    clearAccount(db, username);
    recordAuthEvent(db, 'logout', { username, detail: 'account removed' });
    runtime.log?.(`removed account ${username}`);
    res.setHeader('set-cookie', clearSessionCookie());
    res.json({ ok: true });
  });

  router.post('/account/refresh', requireSession, async (req, res) => {
    const result = await refreshAllowance(db, runtime, req.account.username);
    res.json(result);
  });

  router.post('/settings/default-model', requireSession, (req, res) => {
    const model = typeof req.body?.model === 'string' ? req.body.model : '';
    if (model === '') return res.status(400).json({ ok: false, error: 'model is required' });
    setSetting(db, req.account.username, 'default_model', model);
    res.json({ ok: true, defaultModel: model });
  });

  /* ------------------------------------------------------------------- keys */

  router.get('/keys', requireSession, (req, res) => {
    const owner = req.account.username;
    // `id` breaks ties: keys created in the same millisecond would otherwise
    // come back in an unspecified order.
    const rows = db.prepare('SELECT * FROM api_keys WHERE owner_username = ? ORDER BY created_at DESC, id DESC').all(owner);
    res.json({
      keys: rows.map((row) => publicKey(row, keyUsage(db, row.id, row.limit_window))),
      windows: [...WINDOWS],
      quota: keyQuota(db, owner),
    });
  });

  router.post('/keys', requireSession, (req, res) => {
    // A key must belong to someone: an ownerless key would be invisible in the
    // per-account dashboard and unaccountable in usage.
    const account = req.account;
    const owner = account.username;

    const quota = keyQuota(db, owner);
    if (quota.atLimit) {
      return res.status(409).json({
        ok: false,
        error: `The gateway allows at most ${MAX_KEYS} API keys. Revoke one before creating another.`,
        code: 'key_limit_reached',
      });
    }

    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (name === '') return res.status(400).json({ ok: false, error: 'A key name is required.' });
    if (name.length > 64) return res.status(400).json({ ok: false, error: 'The key name is too long (max 64).' });

    const limits = parseLimits(req.body);
    if (typeof limits === 'string') return res.status(400).json({ ok: false, error: limits });

    const restriction = parseModels(req.body);
    if (typeof restriction === 'string') return res.status(400).json({ ok: false, error: restriction });

    const generated = generateKey();
    // A UUID, not a timestamp plus Math.random(): the id is a primary key, and a
    // collision would fail the insert with no retry.
    const id = `key_${randomUUID()}`;

    db.prepare(`
      INSERT INTO api_keys (
        id, name, prefix, key_hash, created_at, expires_at,
        limit_tokens, limit_requests, limit_window, allowed_models,
        owner_username, owner_key_hash, models_restricted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      name,
      generated.prefix,
      generated.hash,
      Date.now(),
      limits.expiresAt,
      limits.limitTokens,
      limits.limitRequests,
      limits.limitWindow,
      JSON.stringify(restriction.models),
      owner,
      // Which DeepAI key pays for this gateway key: the account's, at creation.
      hashKey(account.apiKey),
      restriction.restricted ? 1 : 0,
    );

    const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
    runtime.log?.(`created API key "${name}" for ${owner}`);
    // The plaintext is returned once and never stored.
    return res.status(201).json({
      key: publicKey(row, keyUsage(db, id, row.limit_window)),
      plaintext: generated.plaintext,
    });
  });

  router.patch('/keys/:id', (req, res) => {
    const row = ownedKey(req, res);
    if (row === undefined) return undefined;

    const limits = parseLimits(req.body, row);
    if (typeof limits === 'string') return res.status(400).json({ ok: false, error: limits });

    const name = typeof req.body?.name === 'string' && req.body.name.trim() !== ''
      ? req.body.name.trim().slice(0, 64)
      : row.name;

    let models = row.allowed_models;
    let restricted = row.models_restricted;
    if ('allowedModels' in (req.body ?? {}) || 'modelsRestricted' in (req.body ?? {})) {
      const parsed = parseModels(req.body, row);
      if (typeof parsed === 'string') return res.status(400).json({ ok: false, error: parsed });
      models = JSON.stringify(parsed.models);
      restricted = parsed.restricted ? 1 : 0;
    }

    db.prepare(`
      UPDATE api_keys
         SET name = ?, expires_at = ?, limit_tokens = ?, limit_requests = ?,
             limit_window = ?, allowed_models = ?, models_restricted = ?
       WHERE id = ?
    `).run(
      name,
      limits.expiresAt,
      limits.limitTokens,
      limits.limitRequests,
      limits.limitWindow,
      models,
      restricted,
      row.id,
    );

    const updated = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(row.id);
    return res.json({ key: publicKey(updated, keyUsage(db, updated.id, updated.limit_window)) });
  });

  /**
   * Revoke a key: it is deleted outright.
   *
   * One destructive action, not two. The key stops working the instant this
   * returns, its slot is freed, and its name can be reused. Usage already
   * recorded keeps its history — those rows carry `key_name`, and the foreign key
   * nulls their `key_id` — so revoking does not erase what the key spent.
   */
  router.post('/keys/:id/revoke', (req, res) => {
    const row = ownedKey(req, res);
    if (row === undefined) return undefined;
    db.prepare('DELETE FROM api_keys WHERE id = ?').run(row.id);
    runtime.log?.(`revoked API key "${row.name}"`);
    return res.json({ ok: true, revoked: { id: row.id, name: row.name } });
  });

  /* ------------------------------------------------------------------ usage */

  router.get('/usage/summary', requireSession, (req, res) => {
    const owner = req.account.username;
    const data = summary(db, Date.now(), owner);
    res.json({
      ...data,
      // What the same traffic would cost on the public APIs these models
      // mirror. Purely an estimate; see src/pricing.js for the caveats.
      savings: {
        month: estimateSavings(data.modelsMonth),
        today: estimateSavings(data.modelsToday),
        all: estimateSavings(data.modelsAll),
        pricing: pricingStatus(),
      },
      balanceLow: isBalanceLow(req.account.allowance),
      allowance: req.account.allowance ?? null,
    });
  });

  /**
   * The reference price table.
   *
   * OpenRouter publishes these rates, so the table itself is public. The status
   * is projected down to its provenance: `lastError` can carry upstream detail
   * and has no business on an unauthenticated endpoint.
   */
  router.get('/pricing', (req, res) => {
    const status = pricingStatus();
    res.json({
      status: {
        source: status.source,
        capturedAt: status.capturedAt,
        fetchedAt: status.fetchedAt,
        ageMs: status.ageMs,
        stale: status.stale,
        ttlMs: status.ttlMs,
        models: status.models,
        priced: status.priced,
      },
      prices: publicPrices(),
    });
  });

  /** Force a refresh from OpenRouter. Authenticated: it performs a network call. */
  router.post('/pricing/refresh', requireSession, async (req, res) => {
    const result = await refreshPrices();
    res.status(result.ok ? 200 : 502).json(result);
  });

  router.get('/usage/recent', requireSession, (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 200);
    const keyId = typeof req.query.keyId === 'string' && req.query.keyId !== '' ? req.query.keyId : undefined;
    res.json({ requests: recent(db, limit, keyId, req.account.username) });
  });

  /**
   * Download the usage history.
   *
   * `?format=csv` (default) or `json`; `?range=today|month|all` bounds it, and
   * `?keyId=` narrows it to one key. Always scoped to the session's account.
   */
  router.get('/usage/export', requireSession, (req, res) => {
    const owner = req.account.username;
    const range = typeof req.query.range === 'string' ? req.query.range : 'all';
    const since = range === 'today' ? startOfDay() : range === 'month' ? startOfMonth() : 0;
    const keyId = typeof req.query.keyId === 'string' && req.query.keyId !== '' ? req.query.keyId : undefined;
    const format = req.query.format === 'json' ? 'json' : 'csv';
    const stamp = new Date().toISOString().slice(0, 10);

    if (format === 'json') {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="deepai-usage-${stamp}.json"`);
      res.write('{"range":' + JSON.stringify(range) + ',"exportedAt":' + JSON.stringify(new Date().toISOString()) + ',"rows":[');
      let first = true;
      for (const row of exportRows(db, { since, keyId, owner })) {
        res.write(`${first ? '' : ','}${JSON.stringify(exportJsonRow(row))}`);
        first = false;
      }
      res.end(']}');
      return;
    }

    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="deepai-usage-${stamp}.csv"`);
    res.write(`${CSV_COLUMNS.join(',')}\n`);
    for (const row of exportRows(db, { since, keyId, owner })) {
      res.write(`${exportCsvRow(row)}\n`);
    }
    res.end();
  });

  router.get('/usage/models', requireSession, (req, res) => {
    const range = typeof req.query.range === 'string' ? req.query.range : 'month';
    const since = range === 'today' ? startOfDay() : range === 'all' ? 0 : startOfMonth();
    res.json({ range, since, models: byModel(db, since, req.account.username) });
  });

  router.get('/usage/keys/:id', (req, res) => {
    const row = ownedKey(req, res);
    if (row === undefined) return undefined;
    const window = typeof req.query.window === 'string' && WINDOWS.includes(req.query.window)
      ? req.query.window
      : row.limit_window;
    // Every figure here describes *this key*. `totals()` is owner-scoped, which
    // would report the whole account's traffic under a single key's heading; the
    // same numbers are derived from the key's own window instead.
    const usage = keyUsage(db, row.id, window);
    return res.json({
      key: publicKey(row, keyUsage(db, row.id, row.limit_window)),
      usage,
      totals: {
        requests: usage.requests,
        totalTokens: usage.totalTokens,
        since: usage.since,
      },
      recent: recent(db, 25, row.id, row.owner_username),
    });
  });

  /* ----------------------------------------------------------------- models */

  /**
   * The model catalog with this account's usage beside it.
   *
   * The catalog itself is public; the usage figures are not, so the identity is
   * required. Either credential works: a dashboard session, or one of the
   * caller's own `sk-` keys (scoped to that key's owner). What is never allowed
   * is no identity at all — that would mean an unscoped usage query.
   */
  router.get('/models', allowKeyIdentity(db), async (req, res) => {
    try {
      const owner = req.account.username;
      const models = await loadCatalog(AbortSignal.timeout(10_000));
      const monthSince = startOfMonth();
      const usageByModel = new Map(byModel(db, monthSince, owner).map((item) => [item.model, item]));
      const allUsage = new Map(byModel(db, 0, owner).map((item) => [item.model, item]));
      res.json({
        models: models.map((model) => ({
          ...publicModel(model),
          usageMonth: usageByModel.get(model.id) ?? null,
          usageAll: allUsage.get(model.id) ?? null,
        })),
      });
    } catch (error) {
      res.status(502).json({ ok: false, error: String(error?.message ?? error) });
    }
  });

  return router;
}

/**
 * Finish a login: persist the DeepAI account, mint a session for this browser and
 * return the cookie value to send.
 *
 * Called by the sign-in routes once a key has been validated. The account and the
 * cookie are written *before* the response is sent, so the browser never lands on
 * the dashboard without its session.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} runtime
 * @param {object} account - `{apiKey, username, isPro}` from the exchange.
 * @param {{secure?: boolean}} [options]
 * @returns {{username: string, created: boolean, cookie: string}}
 */
export function completeLogin(db, runtime, account, options = {}) {
  const saved = saveAccount(db, account);
  const username = saved.account.username;
  pruneSessions(db);
  const session = createSession(db, username);
  recordAuthEvent(db, 'login', {
    username,
    detail: saved.created ? 'account created' : 'logged in',
  });
  runtime.log?.(`logged in as ${username} (${saved.created ? 'new account' : 'existing account'})`);
  // Allowance is a network call; it must not delay the redirect.
  void refreshAllowance(db, runtime, username);
  return {
    username,
    created: saved.created,
    cookie: sessionCookie(session.token, session.expiresAt, { secure: options.secure === true }),
  };
}

/**
 * Validate key limits from a request body. `null` means unlimited and is
 * accepted; a missing field keeps the existing value when editing.
 *
 * @returns {{expiresAt: number|null, limitTokens: number|null, limitRequests: number|null, limitWindow: string}|string}
 */
function parseLimits(body, existing = undefined) {
  const requestedWindow = typeof body?.limitWindow === 'string' ? body.limitWindow : undefined;
  if (requestedWindow !== undefined && !WINDOWS.includes(requestedWindow)) {
    return `limitWindow must be one of: ${WINDOWS.join(', ')}.`;
  }
  const window = requestedWindow ?? existing?.limit_window ?? 'unlimited';

  // An unlimited window means no token or request cap at all.
  if (window === 'unlimited') {
    return {
      expiresAt: readExpiry(body, existing?.expires_at),
      limitTokens: null,
      limitRequests: null,
      limitWindow: window,
    };
  }

  const limitTokens = readLimit(body, 'limitTokens', existing?.limit_tokens);
  if (typeof limitTokens === 'string') return limitTokens;
  const limitRequests = readLimit(body, 'limitRequests', existing?.limit_requests);
  if (typeof limitRequests === 'string') return limitRequests;

  const expires = readExpiry(body, existing?.expires_at);
  if (typeof expires === 'string') return expires;

  return { expiresAt: expires, limitTokens, limitRequests, limitWindow: window };
}

/**
 * Model restriction for a key.
 *
 * `modelsRestricted: false` means every model. `true` means exactly the listed
 * models — including an empty list, which allows nothing. An omitted flag on an
 * existing key keeps its current mode.
 *
 * @returns {{restricted: boolean, models: string[]}|string}
 */
function parseModels(body, existing = undefined) {
  const hasList = Array.isArray(body?.allowedModels);
  const hasFlag = typeof body?.modelsRestricted === 'boolean';
  if (!hasList && !hasFlag) {
    return {
      restricted: existing?.models_restricted === 1,
      models: existing === undefined ? [] : parseExisting(existing),
    };
  }
  const models = hasList
    ? body.allowedModels.filter((item) => typeof item === 'string' && item !== '')
    : parseExisting(existing);
  if (models.length > 64) return 'At most 64 models may be listed for one key.';
  const restricted = hasFlag ? body.modelsRestricted : (existing?.models_restricted === 1);
  return { restricted, models };
}

/** Read the allowed-model list of an existing row. */
function parseExisting(row) {
  try {
    const parsed = JSON.parse(row.allowed_models);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** One numeric limit: null clears it, a positive integer sets it. */
function readLimit(body, field, fallback) {
  if (body === null || typeof body !== 'object' || !(field in body)) {
    return fallback === null || fallback === undefined ? null : Number(fallback);
  }
  const value = body[field];
  if (value === null || value === '' || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return `${field} must be a non-negative number or null.`;
  return Math.trunc(number) === 0 ? null : Math.trunc(number);
}

/** Expiry: `null`/"never" clears it, a date string or epoch sets it. */
function readExpiry(body, fallback) {
  if (body === null || typeof body !== 'object' || !('expiresAt' in body)) {
    return fallback === null || fallback === undefined ? null : Number(fallback);
  }
  const value = body.expiresAt;
  if (value === null || value === '' || value === 'never' || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) return 'expiresAt must be an ISO date, an epoch in ms, or null.';
  return parsed;
}

/** Whether the Theos balance is low enough to warn about. */
function isBalanceLow(allowance) {
  if (allowance === null || allowance === undefined || allowance.balance === null) return false;
  const balance = Number(allowance.balance);
  const granted = Number(allowance.granted);
  if (!Number.isFinite(balance) || !Number.isFinite(granted) || granted <= 0) return false;
  return balance / granted < 0.1;
}

/**
 * Re-read one account's DeepAI allowance and cache it.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} runtime
 * @param {string} username - which account to refresh.
 */
export async function refreshAllowance(db, runtime, username) {
  const account = readAccount(db, username);
  if (account === undefined) return { ok: false, error: 'Not signed in.' };
  const check = await checkKey(account.apiKey, AbortSignal.timeout(15_000));
  if (!check.ok) {
    recordAuthEvent(db, 'denied', { username, detail: check.error });
    return { ok: false, error: check.error };
  }
  saveAllowance(db, username, check.allowance);
  if (typeof check.isPro === 'boolean') savePro(db, username, check.isPro);
  recordAuthEvent(db, 'refresh', { username, detail: `balance ${check.allowance.balance ?? '?'}` });
  runtime.log?.(`allowance refreshed for ${username}: ${check.allowance.balance ?? '?'} Theos`);
  return { ok: true, allowance: check.allowance };
}
