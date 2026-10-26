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
import { checkKey, checkPastedKey, loopbackCallbackUrl, startLogin, usernameForKey } from '../deepai/account.js';
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
 * Ceiling on concurrent pending logins.
 *
 * Generous for real use — a person starts one at a time — but finite, so an
 * unauthenticated flood cannot allocate state without limit.
 */
const MAX_PENDING_LOGINS = 64;

/**
 * What each out-of-band completion failure says to the visitor.
 *
 * Written for someone who is looking at a page that would not load, not at the
 * protocol: every message says what happened to the *sign-in* and what to do
 * next. Mapped from the reason the flow reports, so the message cannot drift from
 * the check that produced it.
 */
const COMPLETION_FAILURES = {
  'not-an-address': [400, 'That does not look like an address. Copy the whole address from the page that did not load — including everything after the “?”.'],
  'too-long': [400, 'That is longer than any address DeepAI sends, so something else must have been pasted.'],
  'no-code': [400, 'That address is missing the sign-in code, so it looks cut off. Copy the entire address from the page that did not load.'],
  'no-state': [400, 'That address is missing its second half, so it looks cut off. Copy the entire address from the page that did not load.'],
  invalid_state: [400, 'That address belongs to a different sign-in than this browser started. Use the address from the page DeepAI just sent you to.'],
  exchange_failed: [400, 'DeepAI did not accept that sign-in code. Press “Log in with DeepAI” to start again.'],
  expired: [410, 'This sign-in timed out. Press “Log in with DeepAI” to start again.'],
  too_many_attempts: [429, 'Too many tries for this sign-in. Press “Log in with DeepAI” to start again.'],
  busy: [409, 'This sign-in is already being finished — give it a moment.'],
};

/**
 * The completion failures that end the attempt.
 *
 * The sign-in flow has already closed itself for each of these, so the entry is
 * dropped too. The address-shaped failures and `busy` are deliberately absent: a
 * mistyped paste must not cost the visitor their sign-in.
 */
const TERMINAL_COMPLETION_REASONS = new Set(['expired', 'too_many_attempts', 'exchange_failed']);

/**
 * What each API-key sign-in failure says to the visitor.
 *
 * A separate table from the completion failures because these are a different
 * situation: there is no waiting sign-in and nothing to retry, only a key that
 * DeepAI would not accept. The `not-for-code` case is the one worth the words —
 * `deepai.org` issues a key for the public model API, and it is not automatically
 * enabled for DeepAI Code, so "wrong key" would send the visitor looking for a
 * mistake they did not make.
 */
const KEY_LOGIN_FAILURES = {
  invalid_key: [400, 'Paste the API key itself — one line, with nothing else around it.'],
  invalid_email: [400, 'That does not look like an email address — it is shown as your account name.'],
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
 * @param {object} runtime - shared sign-in state.
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
    // The address DeepAI will send *this* browser to, derived from the request
    // the dashboard is being served on. It is fixed to loopback by DeepAI, so the
    // dashboard shows it and offers to accept it back; computing it here means the
    // port is right even on a fresh page load, with no client-side bookkeeping.
    const callbackPort = localPort(req, runtime.publicUrl);
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
      // Only this browser's own pending attempt, never another visitor's.
      pendingLogin: runtime.pendingLogins?.get(browserOf(req)) !== undefined,
      origin: publicOrigin(req, runtime.publicUrl),
      callbackUrl: loopbackCallbackUrl(callbackPort),
      callbackPort,
      // Whether the sign-in page is relayed here, in which case the redirect that
      // used to be unreachable is rewritten and the visitor needs no workaround.
      authProxy: runtime.authProxy === true,
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
   * Begin the DeepAI login. Returns the URL so the SPA can navigate to it; the
   * browser-navigable `GET /login` uses the same flow.
   *
   * `callbackUrl` is the address DeepAI will send the browser to. It is the only
   * one it will ever use — loopback, with the port read off this request — so the
   * dashboard shows it and offers to accept it back when a browser elsewhere
   * cannot open it. `listenPort` is the socket this gateway is actually serving
   * on, which is what a port forward has to target.
   */
  router.post('/login', async (req, res) => {
    try {
      const port = localPort(req, runtime.publicUrl);
      const url = await beginLogin(db, runtime, port, {
        browser: browserOf(req),
        pageBase: signInPageBase(req, runtime),
      });
      res.json({
        ok: true,
        url,
        origin: publicOrigin(req, runtime.publicUrl),
        callbackPort: port,
        callbackUrl: loopbackCallbackUrl(port),
        listenPort: req.socket?.localPort ?? 0,
        path: '/auth-callback',
      });
    } catch (error) {
      runtime.log?.(`login could not start: ${error?.message ?? error}`);
      res.status(500).json({ ok: false, error: String(error?.message ?? error) });
    }
  });

  /**
   * Finish a login out of band.
   *
   * DeepAI hard-codes the callback to `127.0.0.1`, so a browser on any other
   * machine lands on a dead address. That address stays in its address bar, and
   * the one-shot code in it is still redeemable, so the dashboard lets the visitor
   * paste it back here.
   *
   * Only the browser that started the attempt can finish it: the pending flow is
   * looked up by this request's login cookie, and the pasted `state` must match
   * the one generated for it. That is why the flow, not the request, owns the
   * validation — and why a bare code with no `state` is refused.
   */
  router.post('/login/complete', async (req, res) => {
    const browser = browserOf(req);
    const flow = runtime.pendingLogins?.get(browser)?.flow;
    if (flow === undefined) {
      return res.status(410).json({
        ok: false,
        error: 'There is no sign-in waiting. Press “Log in with DeepAI” first, then paste the address it sends you to.',
        code: 'no_pending_login',
      });
    }

    const body = req.body ?? {};
    const pasted = typeof body.url === 'string' ? body.url.trim() : '';
    const paired = typeof body.code === 'string' && typeof body.state === 'string'
      && body.code !== '' && body.state !== '';
    if (pasted === '' && !paired) {
      return res.status(400).json({
        ok: false,
        error: 'Paste the address from the page that did not load, then press “Finish signing in”.',
        code: 'missing_address',
      });
    }

    const result = pasted !== ''
      ? await flow.complete(pasted)
      : await flow.submit(body.code, body.state);

    if (result.ok) {
      runtime.pendingLogins.delete(browser);
      const completed = completeLogin(db, runtime, result.account, {
        secure: runtime.trustProxy === true,
      });
      res.setHeader('set-cookie', completed.cookie);
      return res.json({ ok: true, username: completed.username });
    }

    // Only a reason that ends the attempt forgets it. A rejected address or a
    // truncated paste must leave the flow usable, because the whole point is that
    // the visitor tries again with the address copied properly.
    if (TERMINAL_COMPLETION_REASONS.has(result.reason)) runtime.pendingLogins.delete(browser);
    const [status, message] = COMPLETION_FAILURES[result.reason]
      ?? [400, 'That sign-in could not be completed. Start a new login.'];
    return res.status(status).json({ ok: false, error: message, code: result.reason });
  });

  /**
   * Sign in by pasting a DeepAI API key.
   *
   * The browser sign-in has to end at a loopback address DeepAI chooses, which a
   * browser elsewhere cannot open. A key sidesteps the whole dance: it is the same
   * credential the exchange would have produced, so nothing is lost by arriving
   * with it directly. No callback, no password, no proxy.
   *
   * The owner is derived from the key rather than supplied, because
   * `api_keys.owner_username` decides who sees and pays for a key — a name the
   * visitor could type would let them claim someone else's account.
   */
  router.post('/login/key', async (req, res) => {
    const raw = typeof req.body?.key === 'string' ? req.body.key : '';
    // A key travels upstream in a header, so a newline inside it would be a header
    // injection; whitespace around a pasted key is normal and harmless.
    const key = raw.trim();
    if (key === '' || key.length > 512 || /[\r\n]/.test(key)) {
      const [status, message] = KEY_LOGIN_FAILURES.invalid_key;
      return res.status(status).json({ ok: false, error: message, code: 'invalid_key' });
    }

    // A DeepAI key carries no identity, so the name to show is asked for. It is
    // only ever a label: the owner still comes from the key below, which is what
    // stops a typed name from claiming another account.
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      const [status, message] = KEY_LOGIN_FAILURES.invalid_email;
      return res.status(status).json({ ok: false, error: message, code: 'invalid_email' });
    }

    let check;
    try {
      check = await checkPastedKey(key, AbortSignal.timeout(20_000));
    } catch (error) {
      runtime.log?.(`api key sign-in failed: ${error?.message ?? error}`);
      const [status, message] = KEY_LOGIN_FAILURES.unreachable;
      return res.status(status).json({ ok: false, error: message, code: 'unreachable' });
    }

    if (check.ok !== true) {
      const [status, message] = KEY_LOGIN_FAILURES[check.reason] ?? [400, 'That key could not be used.'];
      runtime.log?.(`api key sign-in refused: ${check.reason}`);
      return res.status(status).json({ ok: false, error: message, code: check.reason });
    }

    // A key DeepAI has already issued for an account keeps that account, so pasting
    // the same key twice — or pasting it after a browser sign-in — does not split
    // one DeepAI account across two owners. Only a key never seen before gets a
    // derived owner.
    const known = accountForApiKey(db, key);
    const username = known?.username ?? usernameForKey(key);
    const completed = completeLogin(db, runtime, {
      apiKey: key,
      username,
      isPro: check.isPro,
    }, { secure: runtime.trustProxy === true });

    // The name to show, kept as a setting so `accounts.username` stays the derived
    // owner it has to be.
    setSetting(db, username, 'display_name', email);

    // Persist the allowance just read, so the badge shows a balance immediately
    // rather than waiting for the background refresh.
    saveAllowance(db, username, check.allowance);
    if (typeof check.isPro === 'boolean') savePro(db, username, check.isPro);

    res.setHeader('set-cookie', completed.cookie);
    return res.json({ ok: true, username: completed.username, created: completed.created });
  });

  router.post('/cancel-login', (req, res) => {
    cancelLogin(runtime, browserOf(req));
    res.json({ ok: true });
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
 * The origin the **browser** reached the gateway on.
 *
 * Read from the request rather than from a constant, because the address that
 * matters is the one in the visitor's address bar. An explicit `PUBLIC_URL` wins
 * when a deployment knows its own name; behind a proxy the forwarded pair is
 * next; otherwise the `Host` header is the browser's own answer, which is exactly
 * right.
 *
 * Forwarding headers are only honoured when Express' `trust proxy` is on, since
 * otherwise any client could name its own origin.
 *
 * @param {import('express').Request} req
 * @param {string} [configured] - an explicit `PUBLIC_URL`.
 * @returns {string} `scheme://host[:port]`, or `''` when nothing usable exists.
 */
export function publicOrigin(req, configured) {
  if (typeof configured === 'string' && configured.trim() !== '') {
    try {
      return new URL(configured.trim()).origin;
    } catch {
      /* malformed PUBLIC_URL: fall back to the request itself */
    }
  }

  const forwarded = req.app?.get?.('trust proxy') === true;
  const host = (firstForwarded(forwarded ? req.get('x-forwarded-host') : undefined)
    ?? req.get('host')
    ?? '').trim();
  if (host === '') return '';

  const proto = (firstForwarded(forwarded ? req.get('x-forwarded-proto') : undefined)
    ?? (req.secure === true ? 'https' : 'http')).trim().toLowerCase();
  if (proto !== 'http' && proto !== 'https') return '';

  return `${proto}://${host}`;
}

/**
 * Where to send the browser to sign in.
 *
 * With the relay on, this gateway's own origin: the sign-in page is served here and
 * the redirect DeepAI ends with is rewritten back here, which is the only way a
 * browser that cannot reach loopback can finish. With it off, DeepAI's own page,
 * and the visitor finishes by pasting the address back.
 *
 * @param {import('express').Request} req
 * @param {object} runtime
 * @returns {string|undefined} `undefined` leaves DeepAI's own origin in place.
 */
export function signInPageBase(req, runtime) {
  if (runtime?.authProxy !== true) return undefined;
  // Without a usable origin the relay could not be reached anyway, so DeepAI's own
  // page is the safer answer.
  return publicOrigin(req, runtime.publicUrl) || undefined;
}

/** The first hop of a comma-separated forwarding header. */
function firstForwarded(value) {
  if (typeof value !== 'string') return undefined;
  const first = value.split(',')[0].trim();
  return first === '' ? undefined : first;
}

/**
 * The port the browser used to reach the gateway.
 *
 * DeepAI takes the callback port as a plain integer, so it has to end up as a
 * number DeepAI accepts. The request's own address is preferred over the
 * listening socket: behind a proxy the socket port is the internal one, which is
 * not an address the browser could ever be sent back to.
 *
 * This is only the port DeepAI will put in `http://127.0.0.1:<port>/auth-callback`.
 * No port makes a public host reachable, so the value is used for the port-forward
 * hint and for telling the visitor what to expect.
 *
 * @param {import('express').Request} req
 * @param {string} [configured] - an explicit `PUBLIC_URL`.
 * @returns {number} the port, or `0` when none could be determined.
 */
export function localPort(req, configured) {
  const origin = publicOrigin(req, configured);
  if (origin !== '') {
    const explicit = /:(\d+)$/.exec(new URL(origin).host);
    if (explicit !== null) return Number(explicit[1]);
    // No explicit port, so the browser used the scheme's default.
    return origin.startsWith('https://') ? 443 : 80;
  }

  const fromSocket = req.socket?.localPort;
  if (Number.isInteger(fromSocket) && fromSocket > 0) return fromSocket;
  return 0;
}

/**
 * Start a DeepAI login flow and remember it on the runtime.
 *
 * The flow's promise settles when the browser callback completes, but the
 * callback route owns the HTTP response — so this only starts the attempt. The
 * route calls {@link completeLogin} to persist the account and mint the session.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} runtime
 * @param {number} port - the port the gateway listens on.
 * @param {object} [options]
 * @param {string} [options.browser] - which browser owns the attempt.
 * @param {string} [options.pageBase] - origin serving the sign-in page: this
 *   gateway's when the relay is on, otherwise DeepAI's.
 * @returns {Promise<string>} the DeepAI authorization URL.
 */
export async function beginLogin(db, runtime, port, options = {}) {
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('the gateway port is unknown, so DeepAI cannot call back');
  }

  const browser = options.browser ?? 'default';
  const existing = runtime.pendingLogins?.get(browser);
  // The same browser asking twice reuses its attempt; a *different* browser gets
  // its own. Sharing one global slot let a second visitor take over the first
  // visitor's pending login, which is a session-fixation bug.
  if (existing !== undefined) return existing.flow.url;

  /*
   * Bound the map. `POST /api/login` is unauthenticated by design — it is how a
   * visitor gets a session — and the slot key comes from a cookie the caller
   * controls, with a fresh one minted for any request that lacks it. Without a
   * cap, unauthenticated traffic could allocate a 256-bit state and a timer per
   * request for as long as it kept coming. The oldest attempt is evicted first,
   * so the cap costs a genuine visitor nothing.
   */
  if (runtime.pendingLogins === undefined) runtime.pendingLogins = new Map();
  while (runtime.pendingLogins.size >= MAX_PENDING_LOGINS) {
    const oldest = runtime.pendingLogins.keys().next();
    if (oldest.done === true) break;
    cancelLogin(runtime, oldest.value);
  }

  const flow = startLogin({
    port,
    // The relay needs the browser on this origin; without it DeepAI's own page is
    // the right answer, and the visitor finishes by pasting the address back.
    ...(options.pageBase === undefined ? {} : { pageBase: options.pageBase }),
  });
  runtime.pendingLogins.set(browser, { flow });

  const forget = () => {
    // Only clear this browser's attempt, never another's.
    if (runtime.pendingLogins?.get(browser)?.flow === flow) runtime.pendingLogins.delete(browser);
  };
  flow.done.then(forget, (error) => {
    forget();
    const message = String(error?.message ?? error);
    // A cancelled attempt is routine, not a refusal worth auditing.
    if (!/cancelled/i.test(message)) {
      recordAuthEvent(db, 'denied', { detail: message });
    }
    runtime.log?.(`login failed: ${message}`);
  });
  return flow.url;
}

/** Cancel one browser's pending login. */
export function cancelLogin(runtime, browser = 'default') {
  try {
    runtime.pendingLogins?.get(browser)?.flow?.close?.();
  } catch {
    /* best effort */
  }
  runtime.pendingLogins?.delete(browser);
}

/**
 * Identify the browser that owns a login attempt.
 *
 * A short-lived random cookie is minted on first use. It is not a credential —
 * it only groups one browser's sequential requests so two visitors cannot
 * interfere — so it is not `HttpOnly`-critical, but it is still scoped and
 * cleared once the flow finishes.
 */
export function browserOf(req) {
  return typeof req.loginBrowser === 'string' && req.loginBrowser !== '' ? req.loginBrowser : 'default';
}

/**
 * Finish a login: persist the DeepAI account, mint a session for this browser and
 * return the cookie value to send.
 *
 * Called by the `/auth-callback` route once DeepAI has handed back a code and the
 * exchange succeeded. Keeping this out of the flow object means the account and
 * the cookie are written *before* the response is sent, so the browser never
 * lands on the dashboard without its session.
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
