/**
 * deepai-gateway — OpenAI-compatible gateway in front of DeepAI Code.
 *
 * Wires the database, the DeepAI accounts, the OpenAI surface and the dashboard
 * API into one Express app, then serves the dashboard from `public/`.
 *
 * Multi-user: one row per DeepAI login, one session per browser. A gateway key
 * is bound to the account that created it, and that account pays for its traffic.
 *
 * @module deepai-gateway/server
 */

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from './src/db.js';
import { adminRouter, beginLogin, browserOf, completeLogin, localPort } from './src/api/admin.js';
import { callbackPage } from './src/deepai/account.js';
import { initPricing, pricingStatus, startPricingRefresh } from './src/pricing.js';
import { v1Router } from './src/api/v1.js';
import { prefetchCatalog } from './src/deepai/catalog.js';
import { attachSession } from './src/middleware/session.js';
import { listAccounts, clearSessionCookie, destroySession, recordAuthEvent } from './src/store.js';
import { totalKeyCount } from './src/keys.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Resolve runtime configuration. */
export function config(env = process.env) {
  return {
    port: Number(env.PORT) || 8787,
    host: env.HOST || '127.0.0.1',
    database: env.DATABASE || join(HERE, 'data', 'deepai.db'),
    pricingCache: env.PRICING_CACHE || join(HERE, 'data', 'pricing.json'),
    logRequests: env.LOG_REQUESTS !== '0',
    // Trust `X-Forwarded-*` and mark cookies `Secure` when behind TLS.
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
  };
}

/** Build the Express app. Exported so tests can mount it without listening. */
export function createApp(db, options = {}) {
  const runtime = {
    // One pending login per browser. A single global slot let a second visitor
    // take over the first visitor's attempt.
    pendingLogins: new Map(),
    log: options.log ?? ((message) => console.log(`[deepai-gateway] ${message}`)),
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  if (options.trustProxy === true) app.set('trust proxy', true);

  app.use(express.json({ limit: '16mb' }));

  // Every response is JSON unless a route says otherwise; the dashboard sets
  // its own content types.
  app.use((req, res, next) => {
    res.setHeader('x-gateway', 'deepai-gateway/1.0');
    next();
  });

  if (options.logRequests !== false) {
    app.use((req, res, next) => {
      if (req.path.startsWith('/v1/') || req.path.startsWith('/api/')) {
        const started = Date.now();
        res.on('finish', () => {
          runtime.log(`${req.method} ${req.path} → ${res.statusCode} (${Date.now() - started}ms)`);
        });
      }
      next();
    });
  }

  // Resolve the browser's session before any route runs, so `/api` handlers can
  // ask "which account is this" rather than "is anyone logged in".
  app.use(attachSession(db, { secure: options.trustProxy === true }));

  app.use('/v1', v1Router(db));
  app.use('/api', adminRouter(db, runtime));

  /**
   * Liveness probe.
   *
   * Deliberately unauthenticated so a supervisor can poll it, and deliberately
   * says nothing about the deployment: not who is logged in, not how many
   * accounts exist, not their names. An unauthenticated endpoint must not become
   * a directory of users.
   */
  app.get('/healthz', (req, res) => {
    res.json({ ok: true });
  });

  /**
   * DeepAI redirects the browser here after sign-in. The route lives on the main
   * app, so the whole flow stays on the panel's port — and this is the response
   * that hands the browser its session cookie.
   */
  app.get('/auth-callback', async (req, res) => {
    // The browser coming back carries the same login cookie it started with, so
    // it can only ever complete its own attempt.
    const browser = browserOf(req);
    const pending = runtime.pendingLogins.get(browser);
    if (pending === undefined) {
      return res
        .status(410)
        .type('html')
        .send(callbackPage(
          'Nothing to confirm',
          'No sign-in is waiting. Start one from the dashboard and finish it in the browser.',
          'error',
        ));
    }

    try {
      const result = await pending.flow.handleCallback(req);
      if (result.finished) runtime.pendingLogins.delete(browser);
      // The exchange succeeded: persist the account and mint this browser's
      // session *before* sending the page, so the dashboard it redirects to is
      // already authenticated.
      if (result.account !== undefined) {
        const completed = completeLogin(db, runtime, result.account, {
          secure: options.trustProxy === true,
        });
        res.setHeader('set-cookie', completed.cookie);
      }
      return res.status(result.status).type('html').send(result.html);
    } catch (error) {
      runtime.pendingLogins.delete(browser);
      runtime.log(`callback failed: ${error?.message ?? error}`);
      return res.status(500).type('html').send(callbackPage(
        'Sign-in failed',
        'The callback could not be processed. Return to the dashboard and try again.',
        'error',
      ));
    }
  });

  /**
   * Browser-navigable login: `/login` starts the flow and redirects to DeepAI, so
   * the dashboard can simply navigate to it. `?json=1` answers with the URL
   * instead of redirecting, so the SPA can report a failure in place.
   */
  app.get('/login', async (req, res) => {
    try {
      const url = await beginLogin(db, runtime, localPort(req), { browser: browserOf(req) });
      if (req.query.json === '1') return res.json({ ok: true, url });
      return res.redirect(302, url);
    } catch (error) {
      runtime.log(`login could not start: ${error?.message ?? error}`);
      return res.status(500).json({
        error: {
          message: `Could not start the DeepAI login: ${String(error?.message ?? error)}`,
          type: 'api_error',
          code: 'login_unavailable',
          param: null,
        },
      });
    }
  });

  /**
   * Log out the browser that follows this link, then return to the dashboard.
   *
   * Only this session ends; the DeepAI account and its keys stay, so another
   * signed-in browser is unaffected and signing in again restores the keys.
   */
  app.get('/logout', (req, res) => {
    if (req.sessionToken !== undefined) destroySession(db, req.sessionToken);
    if (req.account !== undefined) {
      recordAuthEvent(db, 'logout', { username: req.account.username, detail: 'session ended via /logout' });
      runtime.log(`logged out ${req.account.username} via /logout`);
    }
    res.setHeader('set-cookie', clearSessionCookie());
    res.redirect(302, '/');
  });

  // Only the dashboard is served as HTML. Everything else under the API
  // prefixes answers with JSON so a client never receives a page it cannot
  // parse.
  app.use(express.static(join(HERE, 'public'), { index: false, extensions: ['html'] }));
  app.get('/', (req, res) => res.sendFile(join(HERE, 'public', 'index.html')));

  app.use((req, res) => {
    const wantsJson = req.path === '/v1' || req.path.startsWith('/v1/')
      || req.path === '/api' || req.path.startsWith('/api/');
    if (wantsJson) {
      return res.status(404).json({
        error: {
          message: `Unknown endpoint: ${req.method} ${req.path}`,
          type: 'invalid_request_error',
          code: 'not_found',
          param: null,
        },
      });
    }
    // Unknown page: hand back the dashboard shell rather than a bare 404, so
    // client-side routes survive a hard refresh.
    res.status(404).sendFile(join(HERE, 'public', 'index.html'));
  });

  // eslint-disable-next-line no-unused-vars -- Express needs the arity.
  app.use((error, req, res, next) => {
    const status = Number.isInteger(error?.status) ? error.status : 500;
    runtime.log(`error on ${req.method} ${req.path}: ${error?.message ?? error}`);
    if (res.headersSent) return res.end();
    res.status(status).json({
      error: {
        message: String(error?.message ?? error),
        type: 'api_error',
        code: error?.code ?? 'internal_error',
        param: null,
      },
    });
  });

  app.locals.runtime = runtime;
  return app;
}

/** Boot the server. */
export function start(overrides = {}) {
  const settings = { ...config(), ...overrides };
  const db = openDatabase(settings.database);
  const app = createApp(db, settings);

  prefetchCatalog();

  // Reference prices come from OpenRouter and are cached on disk, so the
  // dashboard shows real market rates rather than a frozen table.
  initPricing({ cachePath: settings.pricingCache, log: (message) => console.log(`[deepai-gateway] ${message}`) });
  startPricingRefresh({ log: (message) => console.log(`[deepai-gateway] ${message}`) });
  const pricing = pricingStatus();
  console.log(`[deepai-gateway] pricing: ${pricing.source} (${pricing.priced}/${pricing.models} models, captured ${pricing.capturedAt})`);

  // Startup summary. Keys and accounts are read back from disk on purpose: it
  // makes a persistence problem obvious in the log instead of surfacing as a
  // mysteriously empty dashboard.
  const accounts = listAccounts(db);
  const keyCount = totalKeyCount(db);
  console.log(`[deepai-gateway] database: ${settings.database}`);
  console.log(`[deepai-gateway] stored API keys: ${keyCount}`);
  console.log(
    accounts.length === 0
      ? '[deepai-gateway] no DeepAI accounts yet — open the dashboard to log in'
      : `[deepai-gateway] ${accounts.length} DeepAI account${accounts.length === 1 ? '' : 's'}: ${accounts.map((a) => a.username).join(', ')}`,
  );

  const server = app.listen(settings.port, settings.host, () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : settings.port;
    console.log(`[deepai-gateway] listening on http://${settings.host}:${port}`);
    console.log(`[deepai-gateway] OpenAI base URL: http://${settings.host}:${port}/v1`);
    if (settings.host !== '127.0.0.1' && settings.host !== 'localhost') {
      // The dashboard is protected by a cookie, but an operator should still
      // know the panel is reachable from the network.
      console.log('[deepai-gateway] note: HOST is not loopback — the dashboard is reachable from the network');
    }
  });

  const shutdown = () => {
    server.close(() => {
      try {
        // Fold the WAL back into the main file so a plain copy of the database
        // is complete on its own.
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        db.close();
      } catch {
        /* already closed */
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { server, db, app };
}

// Start only when executed directly, not when imported by a test.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  start();
}
