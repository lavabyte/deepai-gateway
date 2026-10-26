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
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from './src/db.js';
import {
  adminRouter,
  beginLogin,
  browserOf,
  completeLogin,
  localPort,
  publicOrigin,
  signInPageBase,
} from './src/api/admin.js';
import { callbackPage, loopbackCallbackUrl } from './src/deepai/account.js';
import { DEFAULT_API_ORIGIN, DEFAULT_PAGE_ORIGIN, authProxyRouter } from './src/deepai/auth-proxy.js';
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
    // The address visitors use, when the deployment knows its own name. It is
    // used to report the origin back to the dashboard; it cannot change where
    // DeepAI sends the browser, because DeepAI fixes that to loopback.
    publicUrl: usableOrigin(env.PUBLIC_URL) ?? '',
    // Relay DeepAI's *page* through this gateway. Off by default: the direct
    // password sign-in below performs DeepAI's own three requests server-side, which
    // needs no relay at all and no list of requests to pass through. Turn it on with
    // AUTH_PROXY=1 only for the browser flow — and note that the visitor's password
    // then passes through this process.
    authProxy: env.AUTH_PROXY === '1' || env.AUTH_PROXY === 'true',
    // Overridable so a test can point the relay at a fixture.
    authPageOrigin: env.AUTH_PAGE_ORIGIN || DEFAULT_PAGE_ORIGIN,
    authApiOrigin: env.AUTH_API_ORIGIN || DEFAULT_API_ORIGIN,
  };
}

/**
 * Normalise a configured public address, or reject it.
 *
 * A typo in `PUBLIC_URL` would otherwise be dropped in silence, leaving the
 * operator to wonder why the dashboard reports the wrong origin. Returning
 * `undefined` lets the caller fall back to the request instead.
 *
 * @param {string|undefined} value
 * @returns {string|undefined} the canonical origin.
 */
function usableOrigin(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  try {
    return new URL(value.trim()).origin;
  } catch {
    console.warn(`[deepai-gateway] PUBLIC_URL is not a usable URL: ${JSON.stringify(value)} — ignoring it`);
    return undefined;
  }
}

/** Build the Express app. Exported so tests can mount it without listening. */
export function createApp(db, options = {}) {
  const runtime = {
    // One pending login per browser. A single global slot let a second visitor
    // take over the first visitor's attempt.
    pendingLogins: new Map(),
    log: options.log ?? ((message) => console.log(`[deepai-gateway] ${message}`)),
    trustProxy: options.trustProxy === true,
    publicUrl: options.publicUrl ?? '',
    authProxy: options.authProxy === true,
    authPageOrigin: options.authPageOrigin ?? DEFAULT_PAGE_ORIGIN,
    authApiOrigin: options.authApiOrigin ?? DEFAULT_API_ORIGIN,
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  if (options.trustProxy === true) app.set('trust proxy', true);

  /*
   * DeepAI's sign-in, relayed. Mounted before the JSON parser on purpose: the login
   * POST carries a password, and a body parser would read it into this process for
   * no reason. The relay streams it straight upstream instead, and logs neither the
   * body nor the cookies.
   */
  if (runtime.authProxy) {
    app.use(authProxyRouter({
      pageOrigin: runtime.authPageOrigin,
      apiOrigin: runtime.authApiOrigin,
      log: runtime.log,
    }));
  }

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
   * DeepAI sends the browser here after sign-in.
   *
   * The host is DeepAI's choice, not ours: it always builds
   * `http://127.0.0.1:<port>/auth-callback`, so this route can only be reached
   * when the browser runs where the redirect can resolve — the gateway's own host,
   * or through a port forward. A visitor anywhere else finishes the login by
   * pasting that address into the dashboard instead, which `POST /api/login/complete`
   * handles. `/callback` is the same handler under the shorter name.
   *
   * The response is also the one that hands the browser its session cookie.
   */
  const handleCallback = async (req, res) => {
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
  };

  app.get('/auth-callback', handleCallback);
  app.get('/callback', handleCallback);

  /**
   * Browser-navigable login: `/login` starts the flow and redirects to DeepAI, so
   * the dashboard can simply navigate to it. `?json=1` answers with the URL
   * instead of redirecting, so the SPA can report a failure in place.
   *
   * The JSON answer also carries the address DeepAI will send the browser back
   * to, because that address is fixed to loopback and a browser elsewhere cannot
   * open it unaided.
   */
  app.get('/login', async (req, res) => {
    try {
      const port = localPort(req, runtime.publicUrl);
      const url = await beginLogin(db, runtime, port, {
        browser: browserOf(req),
        pageBase: signInPageBase(req, runtime),
      });
      if (req.query.json === '1') {
        return res.json({
          ok: true,
          url,
          origin: publicOrigin(req, runtime.publicUrl),
          callbackPort: port,
          callbackUrl: loopbackCallbackUrl(port),
          listenPort: req.socket?.localPort ?? 0,
          path: '/auth-callback',
        });
      }
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

  /*
   * Static assets, with a content-derived version on the shell's references.
   *
   * Deploying new code under the same `/app.js` URL left a browser free to keep
   * serving the copy it already had — which is how a rewritten sign-in screen stayed
   * invisible after it had shipped. The shell is always revalidated, and the assets it
   * names are versioned by their own bytes, so a deploy changes the URL and the
   * browser has nothing stale to reuse.
   */
  const assetVersion = (file) => {
    try {
      const digest = createHash('sha256').update(readFileSync(join(HERE, 'public', file))).digest('hex');
      return `${file}?v=${digest.slice(0, 12)}`;
    } catch {
      return file;
    }
  };
  const shell = () => readFileSync(join(HERE, 'public', 'index.html'), 'utf8')
    .replace('href="/app.css"', `href="/${assetVersion('app.css')}"`)
    .replace('src="/app.js"', `src="/${assetVersion('app.js')}"`);
  const sendShell = (res, status = 200) => res
    .status(status)
    .type('html')
    // The shell must never be stale: it is what names the versioned assets.
    .set('cache-control', 'no-store')
    .send(shell());

  app.use(express.static(join(HERE, 'public'), { index: false, extensions: ['html'] }));
  app.get('/', (req, res) => sendShell(res));

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
    sendShell(res, 404);
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
    const exposed = settings.host !== '127.0.0.1' && settings.host !== 'localhost';
    if (exposed) {
      // The dashboard is protected by a cookie, but an operator should still
      // know the panel is reachable from the network.
      console.log('[deepai-gateway] note: HOST is not loopback — the dashboard is reachable from the network');
    }

    /*
     * `settings`, not the runtime object: this callback belongs to `start()`, where
     * the runtime built inside `createApp` is not in scope. Reading it here crashed
     * the process the moment the server began listening.
     */
    if (settings.authProxy) {
      // The operator should know what the relay implies, and how to turn it off.
      console.log('[deepai-gateway] note: DeepAI sign-in is relayed through this gateway, so a visitor who signs in');
      console.log('[deepai-gateway]       with their DeepAI password sends it through this process (never stored or logged).');
      console.log('[deepai-gateway]       Set AUTH_PROXY=0 to disable; the API-key sign-in needs no password at all.');
    } else if (exposed) {
      // Without the relay, DeepAI's redirect to loopback really is unreachable from
      // another machine, so say so at boot rather than at the first failed login.
      console.log(`[deepai-gateway] note: the DeepAI sign-in callback is fixed to ${loopbackCallbackUrl(port)}`);
      console.log('[deepai-gateway]       a browser elsewhere cannot open it; finish sign-in by pasting that address into the dashboard');
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

/*
 * Start only when executed directly, not when imported by a test.
 *
 * Both sides are resolved through `realpathSync`: `import.meta.url` is already
 * realpath-resolved, while `argv[1]` keeps the path the shell was given. A plain
 * string comparison therefore failed for a symlinked launcher or deploy
 * directory, and the process exited silently with status 0 instead of starting.
 */
function isDirectInvocation() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    // An unreadable argv[1] cannot be this module.
    return false;
  }
}

if (isDirectInvocation()) {
  start();
}
