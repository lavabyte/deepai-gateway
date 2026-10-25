/**
 * deepai-to-api — OpenAI-compatible gateway in front of DeepAI Code.
 *
 * Wires the database, the DeepAI account, the OpenAI surface and the dashboard
 * API into one Express app, then serves the dashboard from `public/`.
 *
 * @module deepai-to-api/server
 */

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from './src/db.js';
import { adminRouter, beginLogin, localPort } from './src/api/admin.js';
import { callbackPage } from './src/deepai/account.js';
import { initPricing, pricingStatus, startPricingRefresh } from './src/pricing.js';
import { v1Router } from './src/api/v1.js';
import { prefetchCatalog } from './src/deepai/catalog.js';
import { clearAccount, readAccount, recordAuthEvent } from './src/store.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Resolve runtime configuration. */
export function config(env = process.env) {
  return {
    port: Number(env.PORT) || 8787,
    host: env.HOST || '127.0.0.1',
    database: env.DATABASE || join(HERE, 'data', 'deepai.db'),
    pricingCache: env.PRICING_CACHE || join(HERE, 'data', 'pricing.json'),
    logRequests: env.LOG_REQUESTS !== '0',
  };
}

/** Build the Express app. Exported so tests can mount it without listening. */
export function createApp(db, options = {}) {
  const runtime = {
    pendingLogin: undefined,
    log: options.log ?? ((message) => console.log(`[deepai-to-api] ${message}`)),
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  app.use(express.json({ limit: '16mb' }));

  // Every response is JSON unless a route says otherwise; the dashboard sets
  // its own content types.
  app.use((req, res, next) => {
    res.setHeader('x-gateway', 'deepai-to-api/1.0');
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

  app.use('/v1', v1Router(db));
  app.use('/api', adminRouter(db, runtime));

  app.get('/healthz', (req, res) => {
    res.json({
      ok: true,
      signedIn: readAccount(db) !== undefined,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  /**
   * DeepAI redirects the browser here after sign-in. The route lives on the
   * main app, so the whole flow stays on the panel's port.
   */
  app.get('/auth-callback', async (req, res) => {
    const pending = runtime.pendingLogin;
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
      if (result.finished) runtime.pendingLogin = undefined;
      return res.status(result.status).type('html').send(result.html);
    } catch (error) {
      runtime.pendingLogin = undefined;
      runtime.log(`callback failed: ${error?.message ?? error}`);
      return res.status(500).type('html').send(callbackPage(
        'Sign-in failed',
        'The callback could not be processed. Return to the dashboard and try again.',
        'error',
      ));
    }
  });

  /**
   * Browser-navigable sign-in: `/login` starts the flow and redirects to
   * DeepAI, so the dashboard can simply link to it. `?json=1` answers with the
   * URL instead of redirecting.
   */
  app.get('/login', async (req, res) => {
    try {
      const url = await beginLogin(db, runtime, localPort(req));
      if (req.query.json === '1') return res.json({ ok: true, url });
      return res.redirect(302, url);
    } catch (error) {
      runtime.log(`sign-in could not start: ${error?.message ?? error}`);
      return res.status(500).json({
        error: {
          message: `Could not start the DeepAI sign-in: ${String(error?.message ?? error)}`,
          type: 'api_error',
          code: 'login_unavailable',
          param: null,
        },
      });
    }
  });

  /** Sign out, then return to the dashboard. */
  app.get('/logout', (req, res) => {
    const account = readAccount(db);
    clearAccount(db);
    recordAuthEvent(db, 'logout', { username: account?.username ?? '', detail: 'signed out via /logout' });
    runtime.log('signed out via /logout');
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
  initPricing({ cachePath: settings.pricingCache, log: (message) => console.log(`[deepai-to-api] ${message}`) });
  startPricingRefresh({ log: (message) => console.log(`[deepai-to-api] ${message}`) });
  const pricing = pricingStatus();
  console.log(`[deepai-to-api] pricing: ${pricing.source} (${pricing.priced}/${pricing.models} models, captured ${pricing.capturedAt})`);

  const account = readAccount(db);

  // Startup summary. Keys are read back from disk here on purpose: it makes a
  // persistence problem obvious in the log instead of surfacing as a mysteriously
  // empty dashboard.
  const keyCount = Number(db.prepare('SELECT COUNT(*) AS n FROM api_keys').get().n);
  console.log(`[deepai-to-api] database: ${settings.database}`);
  console.log(`[deepai-to-api] stored API keys: ${keyCount}`);
  console.log(
    account === undefined
      ? '[deepai-to-api] not signed in to DeepAI — open the dashboard to sign in'
      : `[deepai-to-api] signed in as ${account.username || 'DeepAI user'}`,
  );

  const server = app.listen(settings.port, settings.host, () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : settings.port;
    console.log(`[deepai-to-api] listening on http://${settings.host}:${port}`);
    console.log(`[deepai-to-api] OpenAI base URL: http://${settings.host}:${port}/v1`);
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
