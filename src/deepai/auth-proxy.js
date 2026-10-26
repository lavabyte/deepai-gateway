/**
 * Reverse proxy for DeepAI's sign-in, so the browser never has to reach loopback.
 *
 * DeepAI ends the sign-in by redirecting to `http://127.0.0.1:<port>/auth-callback`,
 * a host it chooses itself and no request can change. A browser on any other
 * machine therefore lands on a dead address — unless the redirect is rewritten,
 * and only something in the middle can rewrite it.
 *
 * That is what this is: the browser talks to this gateway for the whole sign-in,
 * the gateway relays to DeepAI, and the one redirect that decides whether the flow
 * works is put back on the gateway's own origin.
 *
 * ## What has to be true for that to hold
 *
 * The page's own script concatenates `app_base_url + path` and reloads itself with
 * `app_base_url + location.pathname + location.search`. That only lands back on a
 * proxied path if `app_base_url` is empty and the page keeps DeepAI's path, so the
 * page is served at `/deepai_code/desktop_auth/` and the relayed API paths sit at
 * the root (`/daily-time-sync/…`). Rewriting `app_base_url` to a prefix instead
 * would make the self-reload address recurse.
 *
 * ## What this costs, and what it does not do
 *
 * Relaying the sign-in means the visitor's DeepAI **password passes through this
 * process**. It is never buffered to disk, never logged, and never stored — the
 * body is streamed straight upstream — but it does pass through. That is the whole
 * reason the browser sign-in is optional here and the API-key route exists beside
 * it: a key needs no password, no callback and no proxy.
 *
 * Two other limits are worth stating because they are not fixable here:
 *
 *   - **Social sign-in cannot work through a proxy.** Google and Apple would
 *     return the browser to `deepai.org`, where the session cookie is of no use to
 *     us. Those paths answer with an explanation instead of leaving silently.
 *   - **This is a rewrite of somebody else's page.** If DeepAI changes the two
 *     constructs below, the proxy cannot do its job; it then refuses to serve the
 *     page rather than half-working, and the visitor is pointed at the routes that
 *     do not depend on any of it.
 *
 * @module deepai-gateway/deepai/auth-proxy
 */

import express from 'express';

/** Default upstreams. Overridable so a test can substitute a fixture. */
export const DEFAULT_PAGE_ORIGIN = 'https://deepai.org';
export const DEFAULT_API_ORIGIN = 'https://api.deepai.org';

/**
 * Prefix for relayed DeepAI cookies.
 *
 * The browser is the cookie jar — the gateway keeps no session state, so two
 * visitors cannot share one sign-in — and this prefix keeps DeepAI's cookie names
 * from colliding with the gateway's own (`deepai_gateway_session`,
 * `deepai_gateway_login`) on the same origin.
 */
export const COOKIE_PREFIX = 'dai_';

/**
 * The two edits that make the page work under a different host.
 *
 * Both are written as narrow patterns rather than whole-line copies, and both are
 * checked before use: a missing pattern means DeepAI changed the page, and
 * {@link rewriteAuthPage} reports that instead of serving something broken.
 */
const PAGE_REWRITES = [
  {
    name: 'hostname guard',
    // DeepAI bounces the browser to its own host from anywhere except `deepai.org`
    // and `127.0.0.1` — which is exactly why this flow works locally and fails on
    // a public host. Making the first comparison always true disarms the bounce
    // without touching anything else in the script.
    find: /window\.location\.hostname==="deepai\.org"/g,
    replace: 'true',
  },
  {
    name: 'api base',
    // Every API call is `app_base_url + path`, and the self-reload is
    // `app_base_url + pathname + search`. Empty makes both same-origin.
    find: /app_base_url='[^']*'/g,
    replace: "app_base_url=''",
  },
];

/**
 * The paths this proxy will relay, and which upstream answers each.
 *
 * An allowlist rather than a general forwarder: a proxy that will fetch anything
 * on request is an open relay, and this one has no business being one.
 */
const ROUTES = [
  { prefix: '/deepai_code/desktop_auth/', upstream: 'page', page: true },
  // The sign-in page's own assets are absolute paths on its host.
  { prefix: '/static/', upstream: 'page' },
  // Relayed API calls, which `app_base_url=''` turns into same-origin paths.
  { prefix: '/daily-time-sync/', upstream: 'api' },
  { prefix: '/get_user_login_type', upstream: 'api' },
  { prefix: '/get_geo_ip', upstream: 'api' },
  { prefix: '/privacy-preferences/', upstream: 'api' },
  { prefix: '/chat_channels/', upstream: 'api' },
  { prefix: '/log_stat', upstream: 'api' },
];

/** Paths that would leave the proxy, answered with an explanation instead. */
const OFF_PROXY_PREFIXES = ['/accounts/google/', '/accounts/apple/', '/auth/google/'];

/** Request headers worth relaying. Everything else is dropped or set by fetch. */
const RELAY_REQUEST_HEADERS = ['accept', 'accept-language', 'content-type', 'user-agent'];

/**
 * Whether a path is something this proxy will relay.
 *
 * @param {string} path
 * @returns {boolean}
 */
export function isProxiedPath(path) {
  return ROUTES.some((route) => path.startsWith(route.prefix))
    || OFF_PROXY_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Rewrite DeepAI's sign-in page so it works on this origin.
 *
 * @param {string} html
 * @returns {{ok: true, html: string} | {ok: false, missing: string[]}} `ok: false`
 *   lists the constructs that were not found, which means the page changed.
 */
export function rewriteAuthPage(html) {
  let out = String(html);
  const missing = [];
  for (const rule of PAGE_REWRITES) {
    rule.find.lastIndex = 0;
    if (!rule.find.test(out)) {
      missing.push(rule.name);
      continue;
    }
    rule.find.lastIndex = 0;
    out = out.replace(rule.find, rule.replace);
  }
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, html: out };
}

/**
 * Put a redirect from DeepAI back onto this origin.
 *
 * The callback is the point of the whole proxy: DeepAI sends the browser to
 * loopback, and a matching path — whatever host and port it names, since both are
 * DeepAI's choice — is turned into the same path here. Other in-allowlist
 * locations stay on this origin too, so nothing falls out of the proxy mid-flow.
 *
 * @param {string} location - the upstream `Location` header.
 * @param {{pageOrigin: string, apiOrigin: string}} origins
 * @returns {string}
 */
export function rewriteLocation(location, origins) {
  let url;
  try {
    url = new URL(location);
  } catch {
    return location;
  }
  const path = `${url.pathname}${url.search}`;
  if (url.pathname === '/auth-callback') return path;

  const upstreamHosts = new Set([new URL(origins.pageOrigin).host, new URL(origins.apiOrigin).host]);
  if (upstreamHosts.has(url.host) && isProxiedPath(path)) return path;

  return location;
}

/**
 * Re-emit one upstream `Set-Cookie` for this origin.
 *
 * `Domain` has to go, or the browser rejects a cookie for a host it did not talk
 * to; `Path` is normalised to `/`; and `Secure` is kept only when this gateway is
 * actually served over TLS, since a `Secure` cookie on plain HTTP is dropped — and
 * a dropped session cookie looks exactly like a wrong password.
 *
 * @param {string} header - one raw `Set-Cookie` value.
 * @param {boolean} secure
 * @returns {string|undefined}
 */
export function relaySetCookie(header, secure) {
  const [pair, ...attributes] = String(header).split(';');
  const name = pair.slice(0, pair.indexOf('=')).trim();
  if (name === '') return undefined;

  const kept = [`${COOKIE_PREFIX}${pair.trim()}`, 'Path=/'];
  for (const attribute of attributes) {
    const [rawKey, ...rest] = attribute.split('=');
    const key = rawKey.trim().toLowerCase();
    const value = rest.join('=').trim();
    if (key === 'domain' || key === 'path' || key === 'secure' || key === 'samesite') continue;
    if (key === 'expires' || key === 'max-age') kept.push(`${rawKey.trim()}=${value}`);
    if (key === 'httponly') kept.push('HttpOnly');
  }
  // Same-origin requests and top-level navigations both still send `Lax`, so the
  // upstream's own `SameSite` policy buys nothing and can only break the flow.
  kept.push('SameSite=Lax');
  if (secure) kept.push('Secure');
  return kept.join('; ');
}

/**
 * The DeepAI cookies in a browser's `Cookie` header, with the prefix removed.
 *
 * Only relayed names are forwarded: the gateway's own cookies must never travel to
 * DeepAI.
 *
 * @param {string|undefined} cookieHeader
 * @returns {string} a `Cookie` header value, or `''`.
 */
export function upstreamCookieHeader(cookieHeader) {
  if (typeof cookieHeader !== 'string' || cookieHeader === '') return '';
  const relayed = [];
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(COOKIE_PREFIX)) continue;
    relayed.push(trimmed.slice(COOKIE_PREFIX.length));
  }
  return relayed.join('; ');
}

/** Build the headers to send upstream. */
function upstreamHeaders(req, origins) {
  const headers = {};
  for (const name of RELAY_REQUEST_HEADERS) {
    const value = req.get(name);
    if (typeof value === 'string' && value !== '') headers[name] = value;
  }
  const cookies = upstreamCookieHeader(req.get('cookie'));
  if (cookies !== '') headers.cookie = cookies;
  // A cross-origin sign-in POST would otherwise arrive with this gateway as its
  // `Origin`, which DeepAI's own protection is entitled to refuse. Presenting the
  // request as DeepAI's own is the whole point of a proxy of this kind.
  headers.origin = origins.pageOrigin;
  headers.referer = `${origins.pageOrigin}/deepai_code/desktop_auth/`;
  return headers;
}

/**
 * Build the proxy router.
 *
 * @param {object} options
 * @param {string} [options.pageOrigin] - where the sign-in page lives.
 * @param {string} [options.apiOrigin] - where its API lives.
 * @param {(message: string) => void} [options.log]
 * @returns {import('express').Router}
 */
export function authProxyRouter(options = {}) {
  const origins = {
    pageOrigin: options.pageOrigin ?? DEFAULT_PAGE_ORIGIN,
    apiOrigin: options.apiOrigin ?? DEFAULT_API_ORIGIN,
  };
  const log = options.log ?? (() => {});

  const router = express.Router();
  // The sign-in page and its API are relayed byte-for-byte; parsing them would
  // only risk mangling the credentials in the login POST.
  router.use((req, res, next) => {
    /*
     * One normalised URL, used both to decide and to fetch.
     *
     * Checking the allowlist against `req.path` while sending `req.originalUrl`
     * would leave the two free to disagree on an encoded or dotted path — and the
     * allowlist is what keeps this from being an open relay.
     */
    const route = ROUTES.find((candidate) => req.path.startsWith(candidate.prefix));
    const offProxy = OFF_PROXY_PREFIXES.some((prefix) => req.path.startsWith(prefix));
    if (route === undefined && !offProxy) return next();

    const origin = route === undefined
      ? origins.pageOrigin
      : (route.upstream === 'page' ? origins.pageOrigin : origins.apiOrigin);

    let target;
    try {
      target = new URL(`${origin}${req.originalUrl}`);
    } catch {
      return res.status(400).type('text/plain').send('Bad request.');
    }
    if (!isProxiedPath(target.pathname)) return next();

    if (OFF_PROXY_PREFIXES.some((prefix) => target.pathname.startsWith(prefix))) {
      return res.status(501).type('html').send(offProxyPage());
    }

    return relay(req, res, target, route?.page === true, origins, log);
  });

  return router;
}

/** Relay one request upstream and one response back. */
async function relay(req, res, target, isPage, origins, log) {
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';

  let upstream;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: upstreamHeaders(req, origins),
      // Streamed, never read into this process: the login POST carries a password
      // and nothing here should be able to persist it.
      ...(hasBody ? { body: req, duplex: 'half' } : {}),
      redirect: 'manual',
    });
  } catch (error) {
    // Deliberately only the message and the path: a body or a header could carry
    // the credentials this route exists to relay.
    log(`auth proxy: ${req.method} ${req.path} could not reach ${target.origin}: ${error?.message ?? error}`);
    return res.status(502).type('html').send(unreachablePage());
  }

  // Cookies are re-emitted for this origin; nothing else about them is kept.
  const secure = req.secure === true;
  const cookies = upstream.headers.getSetCookie?.() ?? [];
  const relayed = cookies.map((cookie) => relaySetCookie(cookie, secure)).filter(Boolean);
  if (relayed.length > 0) res.setHeader('set-cookie', relayed);

  for (const [name, value] of upstream.headers) {
    const key = name.toLowerCase();
    if (RESPONSE_HEADERS_SKIPPED.has(key)) continue;
    res.setHeader(name, value);
  }

  const location = upstream.headers.get('location');
  if (location !== null && upstream.status >= 300 && upstream.status < 400) {
    res.setHeader('location', rewriteLocation(location, origins));
  }

  /*
   * One line per relayed request, so a sign-in that fails can be diagnosed.
   *
   * Method and path only: `req.path` excludes the query (which carries the sign-in
   * state), and no header or body is ever touched — the login POST's body is a
   * password. The rewritten callback is called out because it is the step that used
   * to be impossible.
   */
  const landed = location !== null && new URL(location, origins.pageOrigin).pathname === '/auth-callback'
    ? ' → callback rewritten to this origin'
    : '';
  log(`auth proxy: ${req.method} ${req.path} → ${upstream.status}${landed}`);

  // Only a page is rewritten. The same path also answers with the redirect that ends
  // the flow, and treating an empty 302 as "the page changed" would break exactly the
  // response this proxy exists to rewrite.
  const isPageBody = isPage && upstream.status >= 200 && upstream.status < 300;
  if (!isPageBody) {
    res.status(upstream.status);
    return pipeBody(upstream, res, log, req);
  }

  // The page has to be rewritten, so it is the one body that is read in full.
  const html = await upstream.text().catch(() => '');
  const rewritten = rewriteAuthPage(html);
  if (!rewritten.ok) {
    log(`auth proxy: DeepAI's sign-in page no longer contains ${rewritten.missing.join(', ')} — refusing to serve it`);
    return res.status(502).type('html').send(changedPage(rewritten.missing));
  }
  res.status(upstream.status);
  return res.type('html').send(rewritten.html);
}

/** Response headers that must not be copied: see {@link relay}. */
const RESPONSE_HEADERS_SKIPPED = new Set([
  'set-cookie',
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  // A policy written for DeepAI's origin would apply to this one and could block
  // the gateway's own scripts; framing rules likewise belong to the other page.
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'strict-transport-security',
]);

/** Stream a response body through without holding it. */
async function pipeBody(upstream, res, log, req) {
  if (upstream.body === null) return res.end();
  try {
    for await (const chunk of upstream.body) {
      if (!res.write(chunk)) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
    return res.end();
  } catch (error) {
    log(`auth proxy: ${req.method} ${req.path} interrupted: ${error?.message ?? error}`);
    return res.destroy();
  }
}

/** Shown when someone tries to sign in with Google or Apple through the proxy. */
function offProxyPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Use your DeepAI email and password</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
    background:#fafafa;color:#171717;font:400 14px/1.55 Inter,system-ui,sans-serif}
  .card{max-width:430px;background:#fff;border:1px solid #eaeaea;border-radius:10px;padding:32px}
  h1{font-size:16px;margin:0 0 8px}
  p{margin:0 0 18px;color:#737373;font-size:13.5px}
  a{display:inline-block;height:34px;line-height:34px;padding:0 14px;border-radius:6px;
    background:#171717;color:#fff;text-decoration:none;font-size:13px}
  @media (prefers-color-scheme: dark){
    body{background:#000;color:#ededed}
    .card{background:#0a0a0a;border-color:rgba(255,255,255,.1)}
    p{color:#a3a3a3}
    a{background:#ededed;color:#000}
  }
</style></head>
<body><main class="card">
  <h1>Sign in with your email and password</h1>
  <p>Signing in with Google or Apple has to finish on DeepAI's own site, so it cannot work
     through this gateway. Use the email and password form instead — it works and stays here.</p>
  <a href="/deepai_code/desktop_auth/">Back to the sign-in form</a>
</main></body></html>`;
}

/** Shown when DeepAI's page changed under us. */
function changedPage(missing) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign-in needs the manual route</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
    background:#fafafa;color:#171717;font:400 14px/1.55 Inter,system-ui,sans-serif}
  .card{max-width:460px;background:#fff;border:1px solid #eaeaea;border-radius:10px;padding:32px}
  h1{font-size:16px;margin:0 0 8px}
  p{margin:0 0 14px;color:#737373;font-size:13.5px}
  code{font-family:ui-monospace,monospace;font-size:12px;background:#fafafa;border:1px solid #eaeaea;
    border-radius:4px;padding:1px 4px}
  a{display:inline-block;height:34px;line-height:34px;padding:0 14px;border-radius:6px;
    background:#171717;color:#fff;text-decoration:none;font-size:13px}
  @media (prefers-color-scheme: dark){
    body{background:#000;color:#ededed}
    .card{background:#0a0a0a;border-color:rgba(255,255,255,.1)}
    p{color:#a3a3a3}
    code{background:#000;border-color:rgba(255,255,255,.1)}
    a{background:#ededed;color:#000}
  }
</style></head>
<body><main class="card">
  <h1>DeepAI changed its sign-in page</h1>
  <p>This gateway relays DeepAI's sign-in so the browser never has to reach the address DeepAI
     sends it to. That relay recognises the page by a few markers, and they are no longer there
     (<code>${missing.join('</code>, <code>')}</code>), so it has stopped rather than half-working.</p>
  <p>Log in with a DeepAI API key instead — it needs no callback and no password.</p>
  <a href="/">Back to the dashboard</a>
</main></body></html>`;
}

/** Shown when the upstream cannot be reached at all. */
function unreachablePage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DeepAI is unreachable</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
    background:#fafafa;color:#171717;font:400 14px/1.55 Inter,system-ui,sans-serif}
  .card{max-width:430px;background:#fff;border:1px solid #eaeaea;border-radius:10px;padding:32px}
  h1{font-size:16px;margin:0 0 8px}
  p{margin:0 0 18px;color:#737373;font-size:13.5px}
  a{display:inline-block;height:34px;line-height:34px;padding:0 14px;border-radius:6px;
    background:#171717;color:#fff;text-decoration:none;font-size:13px}
  @media (prefers-color-scheme: dark){
    body{background:#000;color:#ededed}
    .card{background:#0a0a0a;border-color:rgba(255,255,255,.1)}
    p{color:#a3a3a3}
    a{background:#ededed;color:#000}
  }
</style></head>
<body><main class="card">
  <h1>DeepAI is not answering</h1>
  <p>This is not your mistake. Try again in a moment, or log in with an API key, which
     does not need DeepAI's sign-in page at all.</p>
  <a href="/">Back to the dashboard</a>
</main></body></html>`;
}
