/**
 * Dashboard API: account, keys, usage, models and the auth audit trail.
 *
 * Everything the browser needs for its four views. Keys are created here and
 * the plaintext is returned exactly once, at creation. Every key records the
 * DeepAI account that owns it.
 *
 * @module deepai-to-api/api/admin
 */

import express from 'express';
import { checkKey, startLogin } from '../deepai/account.js';
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
  clearAccount,
  getSetting,
  readAccount,
  recentAuthEvents,
  recordAuthEvent,
  saveAccount,
  saveAllowance,
  savePro,
  setSetting,
} from '../store.js';
import {
  estimateSavings,
  pricingStatus,
  publicPrices,
  refreshPrices,
  refreshPricesIfStale,
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
  totals,
  windowStart,
} from '../usage.js';

/**
 * Mount the dashboard API.
 *
 * Every endpoint that reads keys, usage or events is scoped to the signed-in
 * DeepAI account: the dashboard is per user, so one account never sees another
 * account's keys or traffic.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} runtime - shared sign-in state.
 * @returns {import('express').Router}
 */
export function adminRouter(db, runtime) {
  const router = express.Router();

  /** The signed-in username, or `undefined` after answering 401. */
  function requireOwner(req, res) {
    const account = readAccount(db);
    if (account === undefined) {
      res.status(401).json({
        ok: false,
        error: 'Log in to DeepAI to view your keys and usage.',
        code: 'not_logged_in',
      });
      return undefined;
    }
    return account.username;
  }

  /**
   * Resolve a key the caller owns. Answers 404 for another account's key so the
   * response does not reveal that it exists.
   */
  function ownedKey(db, req, res) {
    const owner = requireOwner(req, res);
    if (owner === undefined) return undefined;
    const row = db.prepare('SELECT * FROM api_keys WHERE id = ? AND owner_username = ?')
      .get(req.params.id, owner);
    if (row === undefined) {
      res.status(404).json({ ok: false, error: 'No such key.' });
      return undefined;
    }
    return row;
  }

  /* ---------------------------------------------------------------- account */

  router.get('/account', async (req, res) => {
    const account = readAccount(db);
    res.json({
      signedIn: account !== undefined,
      username: account?.username ?? '',
      isPro: account?.isPro ?? false,
      allowance: account?.allowance ?? null,
      signedInSince: account?.createdAt ?? null,
      pendingLogin: runtime.pendingLogin !== undefined,
      defaultModel: getSetting(db, 'default_model', 'glm-5.3-flash'),
      balanceLow: isBalanceLow(account?.allowance),
      keyQuota: keyQuota(db),
    });
  });

  router.get('/account/events', (req, res) => {
    // Auth events are per account: without a session there is nothing to show,
    // and another account's history is not the caller's business.
    const owner = requireOwner(req, res);
    if (owner === undefined) return undefined;
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 200);
    res.json({ events: recentAuthEvents(db, limit, owner) });
    return undefined;
  });

  /**
   * Begin the DeepAI sign-in. Returns the URL so the SPA can open it; the
   * browser-navigable `GET /login` uses the same flow.
   */
  router.post('/login', async (req, res) => {
    if (runtime.pendingLogin !== undefined) {
      return res.json({ ok: true, url: runtime.pendingLogin.url });
    }
    try {
      const url = await beginLogin(db, runtime, localPort(req));
      res.json({ ok: true, url });
    } catch (error) {
      runtime.pendingLogin = undefined;
      res.status(500).json({ ok: false, error: String(error?.message ?? error) });
    }
  });

  router.post('/cancel-login', (req, res) => {
    try {
      runtime.pendingLogin?.close?.();
    } catch {
      /* best effort */
    }
    runtime.pendingLogin = undefined;
    res.json({ ok: true });
  });

  /** Sign out. Keys survive so their usage history stays attributable. */
  router.post('/logout', (req, res) => {
    const account = readAccount(db);
    clearAccount(db);
    recordAuthEvent(db, 'logout', { username: account?.username ?? '', detail: 'signed out' });
    runtime.log?.('signed out');
    res.json({ ok: true });
  });

  router.post('/account/refresh', async (req, res) => {
    const result = await refreshAllowance(db, runtime);
    res.json(result);
  });

  router.post('/settings/default-model', (req, res) => {
    const model = typeof req.body?.model === 'string' ? req.body.model : '';
    if (model === '') return res.status(400).json({ ok: false, error: 'model is required' });
    setSetting(db, 'default_model', model);
    res.json({ ok: true, defaultModel: model });
  });

  /* ------------------------------------------------------------------- keys */

  router.get('/keys', (req, res) => {
    const owner = requireOwner(req, res);
    if (owner === undefined) return undefined;
    const rows = db.prepare('SELECT * FROM api_keys WHERE owner_username = ? ORDER BY created_at DESC').all(owner);
    res.json({
      keys: rows.map((row) => publicKey(row, keyUsage(db, row.id, row.limit_window))),
      windows: [...WINDOWS],
      quota: keyQuota(db, owner),
    });
    return undefined;
  });

  router.post('/keys', (req, res) => {
    // A key must belong to someone: an ownerless key would be invisible in the
    // per-user dashboard and unaccountable in usage.
    const account = readAccount(db);
    if (account === undefined) {
      return res.status(401).json({
        ok: false,
        error: 'Log in to DeepAI before creating an API key.',
        code: 'not_logged_in',
      });
    }
    const owner = account.username;

    const quota = keyQuota(db, owner);
    if (quota.atLimit) {
      return res.status(409).json({
        ok: false,
        error: `The gateway allows at most ${MAX_KEYS} API keys. Delete one before creating another.`,
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
    const id = `key_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

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
      hashKey(account.apiKey),
      restriction.restricted ? 1 : 0,
    );

    const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
    runtime.log?.(`created API key "${name}" for ${row.owner_username || 'unknown user'}`);
    // The plaintext is returned once and never stored.
    res.status(201).json({ key: publicKey(row, keyUsage(db, id, row.limit_window)), plaintext: generated.plaintext });
  });

  router.patch('/keys/:id', (req, res) => {
    const row = ownedKey(db, req, res);
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
    res.json({ key: publicKey(updated, keyUsage(db, updated.id, updated.limit_window)) });
  });

  router.post('/keys/:id/revoke', (req, res) => {
    const row = ownedKey(db, req, res);
    if (row === undefined) return undefined;
    db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(Date.now(), row.id);
    runtime.log?.(`revoked API key "${row.name}"`);
    const updated = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(row.id);
    res.json({ key: publicKey(updated, keyUsage(db, updated.id, updated.limit_window)) });
  });

  router.post('/keys/:id/restore', (req, res) => {
    const row = ownedKey(db, req, res);
    if (row === undefined) return undefined;
    db.prepare('UPDATE api_keys SET revoked_at = NULL WHERE id = ?').run(row.id);
    const updated = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(row.id);
    res.json({ key: publicKey(updated, keyUsage(db, updated.id, updated.limit_window)) });
  });

  router.delete('/keys/:id', (req, res) => {
    const row = ownedKey(db, req, res);
    if (row === undefined) return undefined;
    db.prepare('DELETE FROM api_keys WHERE id = ?').run(row.id);
    runtime.log?.(`deleted API key "${row.name}"`);
    res.json({ ok: true });
  });

  /* ------------------------------------------------------------------ usage */

  router.get('/usage/summary', (req, res) => {
    const owner = requireOwner(req, res);
    if (owner === undefined) return undefined;
    const now = Date.now();
    const data = summary(db, now, owner);
    const account = readAccount(db);
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
      balanceLow: isBalanceLow(account?.allowance),
      allowance: account?.allowance ?? null,
    });
  });

  // The live reference table, so the dashboard can show its provenance.
  router.get('/pricing', (req, res) => {
    res.json({ status: pricingStatus(), prices: publicPrices() });
  });

  /** Force a refresh from OpenRouter. */
  router.post('/pricing/refresh', async (req, res) => {
    const result = await refreshPrices();
    res.status(result.ok ? 200 : 502).json(result);
  });

  router.get('/usage/recent', (req, res) => {
    const owner = requireOwner(req, res);
    if (owner === undefined) return undefined;
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 200);
    const keyId = typeof req.query.keyId === 'string' && req.query.keyId !== '' ? req.query.keyId : undefined;
    res.json({ requests: recent(db, limit, keyId, owner) });
    return undefined;
  });

  /**
   * Download the usage history.
   *
   * `?format=csv` (default) or `json`; `?range=today|month|all` bounds it, and
   * `?keyId=` narrows it to one key.
   */
  router.get('/usage/export', (req, res) => {
    const owner = requireOwner(req, res);
    if (owner === undefined) return undefined;
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

  router.get('/usage/models', (req, res) => {
    const owner = requireOwner(req, res);
    if (owner === undefined) return undefined;
    const range = typeof req.query.range === 'string' ? req.query.range : 'month';
    const since = range === 'today' ? startOfDay() : range === 'all' ? 0 : startOfMonth();
    res.json({ range, since, models: byModel(db, since, owner) });
    return undefined;
  });

  router.get('/usage/keys/:id', (req, res) => {
    const row = ownedKey(db, req, res);
    if (row === undefined) return undefined;
    const window = typeof req.query.window === 'string' && WINDOWS.includes(req.query.window)
      ? req.query.window
      : row.limit_window;
    res.json({
      key: publicKey(row, keyUsage(db, row.id, row.limit_window)),
      usage: keyUsage(db, row.id, window),
      totals: totals(db, windowStart(window), row.owner_username),
      recent: recent(db, 25, row.id, row.owner_username),
    });
    return undefined;
  });

  /* ----------------------------------------------------------------- models */

  router.get('/models', async (req, res) => {
    try {
      const owner = readAccount(db)?.username;
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
 * The port this request arrived on. Read from the socket rather than config so
 * the DeepAI callback always points at the listener that is actually serving.
 *
 * @param {import('express').Request} req
 * @returns {number}
 */
export function localPort(req) {
  const fromSocket = req.socket?.localPort;
  if (Number.isInteger(fromSocket) && fromSocket > 0) return fromSocket;
  const host = req.get('host');
  if (typeof host === 'string') {
    const match = /:(\d+)$/.exec(host);
    if (match !== null) return Number(match[1]);
  }
  return 0;
}

/**
 * The DeepAI sign-in flow, shared by the JSON route, `GET /login` and the
 * browser callback. The callback is served by the main app, so it uses the
 * same port as the panel.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} runtime
 * @param {number} port - the port the gateway listens on.
 */
export async function beginLogin(db, runtime, port) {
  if (runtime.pendingLogin !== undefined) return runtime.pendingLogin.url;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('the gateway port is unknown, so DeepAI cannot call back');
  }

  const flow = startLogin({ port });
  runtime.pendingLogin = { url: flow.url, close: flow.close, flow };
  flow.done.then(
    (account) => {
      runtime.pendingLogin = undefined;
      saveAccount(db, account);
      recordAuthEvent(db, 'login', { username: account.username, detail: 'signed in' });
      runtime.log?.(`signed in as ${account.username || 'DeepAI user'}`);
      void refreshAllowance(db, runtime);
    },
    (error) => {
      runtime.pendingLogin = undefined;
      // A cancelled attempt is routine, not a refusal worth auditing.
      const message = String(error?.message ?? error);
      if (!/cancelled/i.test(message)) {
        recordAuthEvent(db, 'denied', { detail: message });
      }
      runtime.log?.(`sign-in failed: ${message}`);
    },
  );
  return flow.url;
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
    return { expiresAt: readExpiry(body, existing?.expires_at), limitTokens: null, limitRequests: null, limitWindow: window };
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
 * models — including an empty list, which allows nothing. An omitted flag on
 * an existing key keeps its current mode.
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

/** Re-read the DeepAI allowance and cache it. */
export async function refreshAllowance(db, runtime) {
  const account = readAccount(db);
  if (account === undefined) return { ok: false, error: 'Not signed in.' };
  const check = await checkKey(account.apiKey, AbortSignal.timeout(15_000));
  if (!check.ok) {
    recordAuthEvent(db, 'denied', { username: account.username, detail: check.error });
    return { ok: false, error: check.error };
  }
  saveAllowance(db, check.allowance);
  if (typeof check.isPro === 'boolean') savePro(db, check.isPro);
  recordAuthEvent(db, 'refresh', { username: account.username, detail: `balance ${check.allowance.balance ?? '?'}` });
  runtime.log?.(`allowance refreshed: ${check.allowance.balance ?? '?'} Theos`);
  return { ok: true, allowance: check.allowance };
}
