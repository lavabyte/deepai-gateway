/**
 * deepai-gateway - OpenAI-compatible gateway in front of DeepAI Code.
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
import { adminRouter } from './src/api/admin.js';
import { advertisedCallbackPort, createCallbackLogin, loopbackCallbackUrl } from './src/deepai/callback-login.js';
import { installMachineIdFromDatabase } from './src/deepai/machine.js';
import { startCatalogRefresh, catalogSnapshot, ensureCatalog, CATALOG_KEY_REFUSED, publicModel } from './src/deepai/catalog.js';
import { installUpstreamPool } from './src/deepai/transport.js';
import { initPricing, pricingStatus, startPricingRefresh } from './src/pricing.js';
import { v1Router } from './src/api/v1.js';
import { attachSession } from './src/middleware/session.js';
import { listAccounts, clearSessionCookie, destroySession, forgetInactiveAccounts, newestAccountApiKey, recordAuthEvent } from './src/store.js';
import { DEFAULT_MAX_KEYS, parseMaxKeys, totalKeyCount } from './src/keys.js';
import { byModel, startOfMonth } from './src/usage.js';
import { escapeHtml, modelPills, modelsUnavailableView, modelsView, localeFor, translator } from './src/web/render.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The window in which the model catalog is re-read, chosen at random between the two. */
const CATALOG_REFRESH_MIN_MS = 10 * 60_000;
const CATALOG_REFRESH_MAX_MS = 20 * 60_000;

/** Resolve runtime configuration. */
export function config(env = process.env) {
  return {
    port: Number(env.PORT) || 8787,
    // Exposed by default: this runs as a gateway for other clients, so binding it to
    // loopback meant every deployment had to set HOST before anything could reach it.
    // The dashboard has no password of its own - access is the DeepAI account - so the
    // README says plainly that this makes the panel reachable from the network.
    host: env.HOST || '0.0.0.0',
    database: env.DATABASE || join(HERE, 'data', 'deepai.db'),
    pricingCache: env.PRICING_CACHE || join(HERE, 'data', 'pricing.json'),
    logRequests: env.LOG_REQUESTS !== '0',
    // Trust `X-Forwarded-*` and mark cookies `Secure` when behind TLS.
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    /*
     * Forget accounts nobody has used for this many days. Off unless asked for: the
     * default of 0 removes nothing, so a deployment has to opt in deliberately. A
     * negative or unparsable value is treated as off rather than as "everything".
     */
    forgetAccountAfterDays: forgetAfterDays(env.FORGET_ACCOUNT_AFTER_DAYS),
    /*
     * How many live API keys one account may hold. Set per deployment, because it is an
     * operator question about the gateway, not about an account. Defaults to the five keys
     * it has always allowed; see `parseMaxKeys` for what a bad value becomes.
     */
    maxKeys: parseMaxKeys(env.MAX_KEYS),
    /*
     * DeepAI's own browser sign-in, finishing at `/callback`. Off by default: DeepAI
     * hard-codes `127.0.0.1` as the redirect host, so it only completes when the browser
     * reaches that address as this gateway. The paste-the-JSON route works from anywhere,
     * which is why it is the default.
     */
  };
}

/**
 * Parse the retention setting.
 *
 * Only a positive, whole number of days turns the sweep on. Everything else - unset,
 * empty, `0`, negative, fractional or nonsense - means "never forget", which is the safe
 * reading for a setting that deletes accounts.
 *
 * @param {string|undefined} value
 * @returns {number} days, or 0 for off.
 */
function forgetAfterDays(value) {
  if (typeof value !== 'string' || value.trim() === '') return 0;
  const days = Number(value.trim());
  if (!Number.isFinite(days) || days <= 0) return 0;
  return Math.floor(days);
}

/** Build the Express app. Exported so tests can mount it without listening. */
export function createApp(db, options = {}) {
  const runtime = {
    log: options.log ?? ((message) => console.log(`[deepai-gateway] ${message}`)),
    trustProxy: options.trustProxy === true,
    // Whether per-request lines are written. Shared with the v1 router, which reports where
    // one completion's time went.
    logRequests: options.logRequests !== false,
    // The key cap for this deployment, or `undefined` to fall back to the default.
    maxKeys: options.maxKeys,
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
          runtime.log(`${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - started}ms)`);
        });
      }
      next();
    });
  }

  // Resolve the browser's session before any route runs, so `/api` handlers can
  // ask "which account is this" rather than "is anyone logged in".
  app.use(attachSession(db));

  /*
   * DeepAI's own sign-in, which is the only way in.
   *
   * Always mounted, not behind a setting: the flow finishes by pasting back the address the
   * browser could not open, which works from anywhere - so there is nothing a deployment
   * could opt out of, and a deployment that had opted out would have no way to sign in at
   * all. Mounted before the dashboard router so `/api/login/complete` is served by the
   * module that owns the pending attempts.
   */
  const callback = createCallbackLogin(db, runtime);
  app.use(callback.router);
  app.post('/api/login/complete', callback.complete);

  app.use('/v1', v1Router(db, runtime));
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
   * serving the copy it already had - which is how a rewritten sign-in screen stayed
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
  /**
   * The dashboard shell, optionally with a page already drawn into it.
   *
   * `page` names the view the server rendered and `html` is its markup. A rendered page also
   * carries the model picker, so the key form needs no catalog call of its own - the catalog
   * comes in with the document or not at all.
   *
   * The body also carries the address DeepAI will redirect a sign-in to. It is a property of
   * *this* deployment - the port it listens on - so the client cannot work it out, and the
   * sign-in field used to show the default port instead of the one in use.
   *
   * @param {import('express').Request} req
   * @param {{page?: string, html?: string, pills?: Array<object>}} [drawn]
   */
  const shell = (req, drawn = {}) => {
    const attributes = [
      `data-callback-url="${escapeHtml(loopbackCallbackUrl(advertisedCallbackPort(req.socket?.localPort)))}"`,
    ];
    if (drawn.page !== undefined) attributes.push(`data-page="${escapeHtml(drawn.page)}"`);
    return readFileSync(join(HERE, 'public', 'index.html'), 'utf8')
      .replace('href="/app.css"', `href="/${assetVersion('app.css')}"`)
      .replace('src="/app.js"', `src="/${assetVersion('app.js')}"`)
      .replace('<body>', `<body ${attributes.join(' ')}>`)
      .replace('<!--model-pills-->', modelPills(drawn.pills ?? catalogSnapshot() ?? []))
      .replace('<!--view-->', drawn.html ?? '');
  };
  const sendShell = (req, res, status = 200, drawn = {}) => res
    .status(status)
    .type('html')
    // The shell must never be stale: it is what names the versioned assets.
    .set('cache-control', 'no-store')
    .send(shell(req, drawn));

  /**
   * Read the catalog for a document, with the key this deployment stores.
   *
   * Every page draws the model picker, because the key form has no other way to learn the
   * list: its pills are cloned out of the document, since there is deliberately no model
   * endpoint to ask. A gateway that has read the catalog once answers this from the kept list,
   * so a warm one pays no round trip - only the first document after a start waits.
   *
   * A read that fails is not a failed page. The picker is then empty and the form says the
   * catalog is unavailable, which is true; a page that refused to load would say less.
   *
   * @returns {Promise<{models: Array<object>|null, reason: string}>}
   */
  const readCatalogForPage = async () => {
    const apiKey = newestAccountApiKey(db);
    if (apiKey === undefined) {
      // No account on this deployment, so there is no key to read the catalog with. Saying so
      // beats asking DeepAI with an empty header and reporting its refusal as a key problem.
      return { models: null, reason: 'no DeepAI account is signed in on this gateway yet' };
    }
    try {
      const models = catalogSnapshot() ?? await ensureCatalog(AbortSignal.timeout(10_000), apiKey);
      return { models, reason: '' };
    } catch (error) {
      if (error?.code === CATALOG_KEY_REFUSED) {
        // The stored DeepAI key is the deployment's, not the visitor's, so an operator has to
        // act - and the log is where they look, since a visitor can do nothing about it.
        runtime.log('model catalog: the stored DeepAI key was refused - sign in again in the dashboard');
      }
      return { models: null, reason: error?.message ?? String(error) };
    }
  };

  app.use(express.static(join(HERE, 'public'), { index: false, extensions: ['html'] }));
  app.get('/', async (req, res) => {
    // The key form's pills come out of this document, so the dashboard needs the catalog too.
    const { models } = await readCatalogForPage();
    sendShell(req, res, 200, { pills: models ?? [] });
  });

  /**
   * The model catalog as a page.
   *
   * Public on purpose: which models exist is DeepAI's published list, and asking a visitor to
   * sign in before showing it made the tab useless to exactly the people comparing a gateway
   * before they use it. What is not public is the traffic beside it - the usage column is
   * drawn only for a signed-in session.
   *
   * Served as a document rather than as JSON, and there is deliberately no model endpoint: an
   * API that hands out the catalog is one somebody else can build their own front end on, which
   * is the thing this gateway exists to be for its callers, not to have done to it.
   */
  app.get('/models', async (req, res) => {
    const t = translator(localeFor(req));
    const { models, reason } = await readCatalogForPage();
    if (models === null) {
      /*
       * `200`, deliberately. The document is what was asked for and it says what happened; a
       * 5xx would only invite a proxy in front to replace this page with its own, which is how
       * the same failure once reached a browser as a bare "Bad gateway" with no explanation.
       */
      return sendShell(req, res, 200, { page: 'models', html: modelsUnavailableView({ t, reason }) });
    }

    const usage = req.account === undefined
      ? null
      : new Map(byModel(db, startOfMonth(), req.account.username).map((item) => [item.model, item]));
    return sendShell(req, res, 200, {
      page: 'models',
      html: modelsView({ models: models.map(publicModel), usage, t }),
      pills: models,
    });
  });

  app.use(async (req, res) => {
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
    // client-side routes survive a hard refresh. It is a full shell, so it carries the model
    // picker for the same reason `/` does.
    const { models } = await readCatalogForPage();
    sendShell(req, res, 404, { pills: models ?? [] });
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
  const log = (message) => console.log(`[deepai-gateway] ${message}`);

  /*
   * Settle the machine identity before anything can be requested.
   *
   * DeepAI grants its daily Credits per machine and answers `machine_required` to a build it
   * cannot identify - which reads as a key problem and is not one. The host supplies it when
   * it can; otherwise the database is given one that persists, because a container has no
   * identifier to read and no operator to set a variable in most of the deployments that
   * matter here.
   */
  installMachineIdFromDatabase(db, log);

  /*
   * One pooled, kept-alive connection to DeepAI, before anything can be requested.
   *
   * The alternative - a fresh TCP and TLS handshake per request, which is what the built-in
   * client's four-second idle timeout amounts to for a gateway - costs about 700 ms of every
   * turn. See `src/deepai/transport.js`.
   */
  installUpstreamPool({ log });

  const app = createApp(db, settings);

  /*
   * Keep the model catalog current on a random ten to twenty minute schedule.
   *
   * Random rather than fixed so that two deployments of this gateway do not read it in the
   * same minute forever. The first read happens right away; a failed one keeps the previous
   * list and is logged rather than emptying the catalog.
   */
  startCatalogRefresh({
    log,
    minMs: CATALOG_REFRESH_MIN_MS,
    maxMs: CATALOG_REFRESH_MAX_MS,
    /*
     * Lane 6 requires an account key on the catalog read, so the schedule has to send one -
     * without it every refresh was answered 401 and the catalog only ever loaded when a
     * dashboard request happened to arrive. The catalog is the same for every account, so
     * any live key answers it; the most recently used account is the likeliest to still be
     * signed in. Read at each refresh rather than captured here, so signing in again is
     * picked up without a restart.
     */
    apiKey: () => newestAccountApiKey(db),
  });

  // Reference prices come from OpenRouter and are cached on disk, so the
  // dashboard shows real market rates rather than a frozen table.
  initPricing({ cachePath: settings.pricingCache, log });
  startPricingRefresh({ log });
  const pricing = pricingStatus();
  console.log(`[deepai-gateway] pricing: ${pricing.source} (${pricing.priced}/${pricing.models} models, captured ${pricing.capturedAt})`);

  // Startup summary. Keys and accounts are read back from disk on purpose: it
  // makes a persistence problem obvious in the log instead of surfacing as a
  // mysteriously empty dashboard.
  const accounts = listAccounts(db);
  const keyCount = totalKeyCount(db);
  console.log(`[deepai-gateway] database: ${settings.database}`);
  console.log(`[deepai-gateway] stored API keys: ${keyCount}`);
  // A deployment that set a limit other than the default, so a key-count problem is visible
  // in the log rather than puzzling in the dashboard. The default says nothing: it is the
  // value every deployment started with.
  if (settings.maxKeys !== DEFAULT_MAX_KEYS) {
    console.log(`[deepai-gateway] API key limit per account: ${settings.maxKeys} (MAX_KEYS)`);
  }
  console.log(
    accounts.length === 0
      ? '[deepai-gateway] no DeepAI accounts yet - open the dashboard to log in'
      : `[deepai-gateway] ${accounts.length} DeepAI account${accounts.length === 1 ? '' : 's'}: ${accounts.map((a) => a.username).join(', ')}`,
  );

  /*
   * Inactivity retention, when a deployment asks for it.
   *
   * Runs once at boot and then daily, because a gateway that stays up for months should
   * still forget: a boot-only sweep would never fire on a long-running process. The timer
   * is unref'd so it cannot hold the process open.
   */
  const sweep = (why) => {
    const days = settings.forgetAccountAfterDays;
    if (!Number.isFinite(days) || days <= 0) return;
    try {
      const removed = forgetInactiveAccounts(db, { days });
      for (const account of removed) {
        console.log(`[deepai-gateway] forgot ${account.username}: unused for ${account.idleDays} days (limit ${days}), ${account.keys} key(s) deleted`);
      }
      if (removed.length > 0) {
        console.log(`[deepai-gateway] retention sweep (${why}): ${removed.length} account(s) forgotten, usage history kept`);
      }
    } catch (error) {
      // A failed sweep must not stop the gateway: the accounts are still there, and the
      // next run tries again.
      console.error(`[deepai-gateway] retention sweep failed: ${error?.message ?? error}`);
    }
  };
  sweep('startup');
  setInterval(() => sweep('daily'), 24 * 60 * 60_000).unref();

  const server = app.listen(settings.port, settings.host, () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : settings.port;
    console.log(`[deepai-gateway] listening on http://${settings.host}:${port}`);
    console.log(`[deepai-gateway] OpenAI base URL: http://${settings.host}:${port}/v1`);
    const exposed = settings.host !== '127.0.0.1' && settings.host !== 'localhost';
    if (exposed) {
      // The dashboard is protected by a cookie, but an operator should still
      // know the panel is reachable from the network.
      console.log('[deepai-gateway] note: HOST is not loopback - the dashboard is reachable from the network');
    }
    // A setting that deletes accounts is worth stating out loud at every boot.
    if (settings.forgetAccountAfterDays > 0) {
      console.log(`[deepai-gateway] retention: accounts unused for ${settings.forgetAccountAfterDays} day(s) are forgotten (FORGET_ACCOUNT_AFTER_DAYS); usage history is kept`);
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
