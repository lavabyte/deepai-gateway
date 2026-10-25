/**
 * DeepAI sign-in, mirroring the desktop app but served from the panel itself.
 *
 *   1. the dashboard opens `https://api.deepai.org/deepai_code/desktop_auth/`
 *      with `state` and `port` — the only two inputs DeepAI accepts;
 *   2. DeepAI redirects the browser to
 *      `http://127.0.0.1:<port>/auth-callback?code=…&state=…`;
 *   3. the gateway exchanges the code for an `api_key` at
 *      `POST /deepai_code/desktop_auth/exchange/`.
 *
 * **The callback host is not ours to choose.** DeepAI implements RFC 8252 for a
 * native client: the desktop app binds `127.0.0.1:0`, hands DeepAI the ephemeral
 * port, and DeepAI hard-codes the loopback host when it builds the redirect.
 * `port` is parsed as a plain TCP port — a full URL, a `host:port` pair, `0`,
 * `-1`, an empty value and a path suffix are each rejected with
 * `400 Invalid desktop sign-in request` — so no parameter exists through which a
 * public origin could be passed. The redirect is not built client-side either:
 * the sign-in page polls `/daily-time-sync/user/` and then reloads *itself*,
 * leaving the redirect to the server, which only ever learns a port number.
 *
 * A browser anywhere other than the gateway's own host therefore cannot open the
 * redirect by itself. Two supported ways to finish such a login:
 *
 *   - **Out-of-band completion** — {@link startLogin}'s `complete()` accepts the
 *     address the browser was sent to (or an explicit `code` + `state`), so a
 *     visitor can paste back the address their browser failed to open. This is
 *     what makes a public deployment work, and it is the dashboard's advice.
 *   - **A port forward** — `ssh -L <port>:127.0.0.1:<gateway port> …` maps the
 *     loopback redirect back onto the gateway.
 *
 * There is no second listener: the callback route lives on the main app, so
 * whenever the redirect does resolve it lands on the gateway itself and shares
 * the panel's origin, port and firewall rule.
 *
 * @module deepai-gateway/deepai/account
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { API_ORIGIN, LANE_HEADERS, laneHeaders } from './wire.js';

/**
 * Constant-time equality for two secrets.
 *
 * `state` is a 256-bit secret binding a code to the attempt that asked for it, so
 * comparing it with `===` would leak its prefix through timing. Lengths are
 * checked first because `timingSafeEqual` throws on a mismatch, and a length is
 * not secret.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
function sameSecret(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8');
  const b = Buffer.from(String(right ?? ''), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The address DeepAI will send the browser to.
 *
 * Fixed to loopback by DeepAI, so it is not configurable — exported only so the
 * dashboard can show the visitor which address to expect, and what to copy when
 * it does not open.
 *
 * @param {number} port
 * @returns {string}
 */
export function loopbackCallbackUrl(port) {
  return `http://127.0.0.1:${Number(port) || 0}/auth-callback`;
}

/**
 * Pull `code` and `state` out of whatever a visitor pasted.
 *
 * The redirect that fails to open is still in the browser's address bar, so the
 * usual input is a whole URL. A bare code is deliberately rejected: without the
 * `state` nothing proves the code was minted for *this* attempt, and redeeming an
 * unbound code is precisely what the `state` parameter exists to prevent.
 *
 * @param {unknown} input
 * @returns {{code: string, state: string} | undefined} `undefined` when the text
 *   is not an address carrying both parameters.
 */
export function parseCallbackInput(input) {
  if (typeof input !== 'string') return undefined;
  // Browsers, chat clients and terminals like to hand back a quoted link.
  const text = input.trim().replace(/^[<'"]+|[>'"]+$/g, '').trim();
  if (text === '' || text.length > 8192) return undefined;

  let params;
  try {
    // A base is supplied so a bare `?code=…&state=…` fragment also parses; text
    // with no query at all simply yields no parameters below.
    params = new URL(text, 'http://127.0.0.1').searchParams;
  } catch {
    return undefined;
  }
  const code = params.get('code') ?? '';
  const state = params.get('state') ?? '';
  if (code === '' || state === '') return undefined;
  return { code, state };
}

/**
 * Begin a sign-in attempt.
 *
 * @param {object} params
 * @param {number} params.port - the port that goes into the callback DeepAI
 *   builds. It must be a plain integer: it is the only input DeepAI accepts.
 * @param {number} [params.timeoutMs] - how long the attempt stays valid.
 * @param {number} [params.maxAttempts] - how many rejected `code`/`state` pairs
 *   the attempt tolerates before it gives up. Both entry points are
 *   unauthenticated, so a pending attempt must not become an unlimited oracle.
 * @returns {object} the flow: `url`, `state`, `done`, `close`, `submit`,
 *   `complete` and `handleCallback`.
 */
export function startLogin({ port, timeoutMs = 300_000, maxAttempts = 5 }) {
  const state = randomBytes(32).toString('hex');

  let settleResolve;
  let settleReject;
  const done = new Promise((resolve, reject) => {
    settleResolve = resolve;
    settleReject = reject;
  });
  done.catch(() => {});

  let closed = false;
  let exchanging = false;

  const timer = setTimeout(() => {
    if (closed) return;
    closed = true;
    settleReject(new Error('DeepAI sign-in timed out'));
  }, timeoutMs);
  timer.unref?.();

  const finish = (error, account) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    if (error) settleReject(error);
    else settleResolve(account);
  };

  const url = new URL('/deepai_code/desktop_auth/', API_ORIGIN);
  url.search = new URLSearchParams({ state, port: String(port) }).toString();

  let attemptsLeft = maxAttempts;

  /**
   * Validate one `code`/`state` pair and exchange it.
   *
   * Both entry points — the loopback callback route and out-of-band completion —
   * funnel through here, so they cannot drift apart in what they accept.
   *
   * A rejected pair costs one attempt rather than ending the flow, so a visitor
   * who pastes a truncated address can simply paste it again. A *failed exchange*
   * does end it: the code is one-shot, so retrying the same one cannot succeed.
   * So does the last rejected pair: the endpoint is unauthenticated, so it must
   * not remain a free guessing oracle for the 256-bit state.
   *
   * @param {unknown} rawCode
   * @param {unknown} rawState
   * @returns {Promise<{ok: true, account: object} | {ok: false, reason: string}>}
   */
  async function submit(rawCode, rawState) {
    if (closed) return { ok: false, reason: 'expired' };

    const code = typeof rawCode === 'string' ? rawCode : '';
    const returned = typeof rawState === 'string' ? rawState : '';
    if (code === '' || code.length > 4096 || !sameSecret(returned, state)) {
      attemptsLeft -= 1;
      // The last rejected pair ends the attempt, so an unauthenticated endpoint
      // cannot be turned into an unlimited guessing oracle. Reporting that reason
      // here — rather than letting a later call discover a closed flow — keeps the
      // cause attached to the request that caused it.
      if (attemptsLeft <= 0) {
        finish(new Error('too many DeepAI sign-in attempts'));
        return { ok: false, reason: 'too_many_attempts' };
      }
      return { ok: false, reason: 'invalid_state' };
    }
    if (exchanging) return { ok: false, reason: 'busy' };
    exchanging = true;

    try {
      const account = await exchangeCode(code);
      finish(undefined, account);
      return { ok: true, account };
    } catch (error) {
      finish(error);
      return { ok: false, reason: 'exchange_failed' };
    }
  }

  return {
    url: url.href,
    state,
    done,
    close: () => finish(new Error('DeepAI sign-in cancelled')),
    submit,

    /**
     * Finish the attempt out of band.
     *
     * DeepAI redirects to loopback, which a browser on another machine cannot
     * open. That address stays in the browser's address bar, so this accepts it
     * verbatim (or a `?code=…&state=…` fragment) and applies exactly the checks
     * the callback route would have applied.
     *
     * @param {unknown} input - the pasted address.
     * @returns {Promise<{ok: true, account: object} | {ok: false, reason: string}>}
     */
    async complete(input) {
      if (closed) return { ok: false, reason: 'expired' };
      const parsed = parseCallbackInput(input);
      if (parsed === undefined) return { ok: false, reason: 'unparsable' };
      return submit(parsed.code, parsed.state);
    },

    /**
     * Handle the browser callback.
     *
     * The resolved account is returned **in the result** rather than only through
     * `done`: the caller owns the HTTP response and must be able to persist the
     * account and set the session cookie before sending it. Resolving `done` is
     * asynchronous, so relying on it here would race the response.
     *
     * @param {{query: Record<string, unknown>, method: string}} req
     * @returns {Promise<{status: number, html: string, finished: boolean, account?: object}>}
     */
    async handleCallback(req) {
      if (req.method !== 'GET') {
        return {
          status: 405,
          html: callbackPage('Invalid callback', 'DeepAI sent an unexpected response. Start the login again from the dashboard.', 'error'),
          finished: false,
        };
      }

      const result = await submit(req.query.code, req.query.state);
      if (result.ok) {
        return {
          status: 200,
          html: callbackPage('Logged in to DeepAI', 'The gateway now has your account and can serve requests.', 'ok', { returnTo: '/' }),
          finished: true,
          account: result.account,
        };
      }

      switch (result.reason) {
        case 'expired':
          return {
            status: 410,
            html: callbackPage('Login expired', 'This attempt timed out. Start a new one from the dashboard.', 'error'),
            finished: true,
          };
        case 'busy':
          return {
            status: 409,
            html: callbackPage('Already in progress', 'A login is already waiting for the browser. Finish it, or cancel it in the dashboard.', 'error'),
            finished: false,
          };
        case 'too_many_attempts':
          return {
            status: 429,
            html: callbackPage('Too many attempts', 'Start the login again from the dashboard.', 'error'),
            finished: true,
          };
        case 'exchange_failed':
          return {
            status: 400,
            html: callbackPage('Login failed', 'The code could not be exchanged. Return to the dashboard and try again.', 'error'),
            finished: true,
          };
        default:
          return {
            status: 400,
            html: callbackPage('Invalid callback', 'DeepAI sent an unexpected response. Start the login again from the dashboard.', 'error'),
            finished: false,
          };
      }
    },
  };
}

/**
 * Landing page shown in the browser after DeepAI redirects back.
 *
 * Styled with the same Geist palette as the dashboard and follows the OS
 * colour scheme (`prefers-color-scheme`), with the dashboard's stored theme
 * taking precedence when the browser still has it.
 *
 * @param {string} title - short heading.
 * @param {string} message - one-line explanation.
 * @param {'ok'|'error'} tone
 * @param {object} [options]
 * @param {string} [options.returnTo] - navigate here automatically after a
 *   short confirmation, because the login happens in the panel's own tab.
 * @returns {string} a complete HTML document.
 */
export function callbackPage(title, message, tone, options = {}) {
  const accent = tone === 'ok' ? 'var(--ok)' : 'var(--err)';
  const glyph = tone === 'ok' ? '&#10003;' : '&#10005;';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title} — DeepAI Gateway</title>
<style>
  :root{
    --bg:#fafafa; --surface:#fff; --ink:#171717; --text-2:#737373; --text-3:#a3a3a3;
    --hairline:#eaeaea; --hairline-strong:#d4d4d4;
    --ok:#17c964; --err:#ee0000; --btn-bg:#171717; --btn-fg:#fff;
  }
  @media (prefers-color-scheme: dark){
    :root{
      --bg:#000; --surface:#0a0a0a; --ink:#ededed; --text-2:#a3a3a3; --text-3:#737373;
      --hairline:rgba(255,255,255,.1); --hairline-strong:rgba(255,255,255,.2);
      --ok:#4ade80; --err:#ff7a7a; --btn-bg:#ededed; --btn-fg:#000;
    }
  }
  /* The dashboard's explicit choice wins over the OS preference. */
  html[data-theme="light"]{
    --bg:#fafafa; --surface:#fff; --ink:#171717; --text-2:#737373; --text-3:#a3a3a3;
    --hairline:#eaeaea; --hairline-strong:#d4d4d4;
    --ok:#17c964; --err:#ee0000; --btn-bg:#171717; --btn-fg:#fff;
  }
  html[data-theme="dark"]{
    --bg:#000; --surface:#0a0a0a; --ink:#ededed; --text-2:#a3a3a3; --text-3:#737373;
    --hairline:rgba(255,255,255,.1); --hairline-strong:rgba(255,255,255,.2);
    --ok:#4ade80; --err:#ff7a7a; --btn-bg:#ededed; --btn-fg:#000;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  button,a,[role="button"]{cursor:pointer}
  button:disabled{cursor:default;opacity:.6}
  body{
    min-height:100vh; display:grid; place-items:center; padding:24px;
    background:var(--bg); color:var(--ink);
    font:400 14px/1.5 Inter,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
    font-feature-settings:"liga";
  }
  .card{
    width:min(420px,100%); background:var(--surface);
    border:1px solid var(--hairline); border-radius:10px;
    padding:36px 32px; text-align:center;
  }
  .mark{
    width:40px;height:40px;border-radius:999px;margin:0 auto 20px;
    display:grid;place-items:center;background:${accent};
    color:#fff;font-size:19px;line-height:1;font-weight:600;
  }
  h1{font-size:17px;font-weight:600;letter-spacing:-.02em;margin-bottom:8px}
  p{color:var(--text-2);font-size:13.5px;margin-bottom:24px}
  .actions{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
  /* Selector is the class alone: a.btn would miss a <button> element. */
  .btn{
    display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 16px;
    border-radius:6px;font-family:inherit;font-size:13px;font-weight:500;line-height:1;
    text-decoration:none;cursor:pointer;
    background:var(--btn-bg);color:var(--btn-fg);border:1px solid var(--btn-bg);
    transition:background .15s,color .15s,border-color .15s,opacity .15s;
  }
  .btn:hover{opacity:.85}
  .btn--ghost{background:transparent;color:var(--ink);border-color:var(--hairline-strong)}
  .btn--ghost:hover{border-color:var(--ink);opacity:1}
  .foot{margin:22px 0 0;font-size:11.5px;color:var(--text-3)}
  @media (prefers-reduced-motion: no-preference){
    .card{animation:rise .18s ease}
    @keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  }
</style>
</head>
<body>
  <main class="card">
    <div class="mark" aria-hidden="true">${glyph}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <div class="actions">
      <a class="btn" href="/">Back to the dashboard</a>
    </div>
    <p class="foot">${options.returnTo
      ? 'Taking you back to the dashboard…'
      : 'Start the login again from the dashboard.'}</p>
  </main>
  <script>
    // Honour the theme the dashboard already stored. Only an explicit choice
    // overrides the OS preference; 'system' leaves prefers-color-scheme in
    // charge.
    try {
      var saved = localStorage.getItem('deepai-gateway-theme');
      if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
    } catch (e) {}

    // Login ran in this tab, so hand it straight back to the dashboard. The
    // redirect replaces the history entry, so Back does not land on this page.
    var returnTo = ${JSON.stringify(options.returnTo ?? null)};
    if (returnTo) setTimeout(function () { location.replace(returnTo + '?logged-in=1'); }, 1200);
  </script>
</body>
</html>`;
}

/** Exchange the one-shot sign-in code for an API key. */
async function exchangeCode(code) {
  const response = await fetch(`${API_ORIGIN}/deepai_code/desktop_auth/exchange/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...LANE_HEADERS },
    body: JSON.stringify({ code }),
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`DeepAI sign-in exchange: HTTP ${response.status}`);
  const data = await response.json();
  if (data === null || typeof data !== 'object' || typeof data.api_key !== 'string' || data.api_key === '') {
    throw new Error('DeepAI sign-in returned an invalid response');
  }
  return {
    apiKey: data.api_key,
    username: typeof data.username === 'string' ? data.username : '',
    isPro: data.is_pro === true,
  };
}

/**
 * Read the account allowance (`GET /deepai_code/theos`). This is the Theos
 * balance Premier models are billed against.
 *
 * @param {string} apiKey
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ok: boolean, allowance?: object, isPro?: boolean, error?: string}>}
 */
export async function checkKey(apiKey, signal) {
  if (typeof apiKey !== 'string' || apiKey === '') return { ok: false, error: 'no key stored' };
  try {
    const [allowanceResponse, entitlementResponse] = await Promise.all([
      fetch(`${API_ORIGIN}/deepai_code/theos`, {
        headers: { ...laneHeaders(), 'Api-Key': apiKey },
        signal,
      }),
      fetch(`${API_ORIGIN}/get_usage_summary`, {
        headers: { ...laneHeaders(), 'Api-Key': apiKey },
        signal,
      }).catch(() => undefined),
    ]);

    if (allowanceResponse.status === 401 || allowanceResponse.status === 403) {
      return { ok: false, error: 'the key was rejected' };
    }
    if (!allowanceResponse.ok) return { ok: false, error: `HTTP ${allowanceResponse.status}` };

    const data = await allowanceResponse.json().catch(() => ({}));
    const entitlement = entitlementResponse?.ok
      ? await entitlementResponse.json().catch(() => undefined)
      : undefined;

    return {
      ok: true,
      allowance: {
        enabled: data?.enabled !== false,
        balance: typeof data?.balance === 'string' ? data.balance : null,
        granted: typeof data?.granted === 'string' ? data.granted : null,
        refreshAt: typeof data?.refresh_at === 'string' ? data.refresh_at : null,
      },
      ...(typeof entitlement?.is_pro === 'boolean' ? { isPro: entitlement.is_pro } : {}),
    };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
