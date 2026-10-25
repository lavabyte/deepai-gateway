/**
 * DeepAI sign-in, mirroring the desktop app but served from the panel itself.
 *
 *   1. the dashboard opens `https://api.deepai.org/deepai_code/desktop_auth/`
 *      with `state` and `port` — the port the gateway already listens on;
 *   2. DeepAI redirects the browser to
 *      `http://127.0.0.1:<panel port>/auth-callback?code=…&state=…`;
 *   3. the gateway exchanges the code for an `api_key` at
 *      `POST /deepai_code/desktop_auth/exchange/`.
 *
 * There is no second listener: the callback route lives on the main app, so
 * the flow shares the panel's origin, port and firewall rule.
 *
 * @module deepai-gateway/deepai/account
 */

import { randomBytes } from 'node:crypto';
import { API_ORIGIN, LANE_HEADERS, laneHeaders } from './wire.js';

/**
 * Begin a sign-in attempt.
 *
 * @param {object} params
 * @param {number} params.port - the port the gateway listens on.
 * @param {number} [params.timeoutMs] - how long the attempt stays valid.
 * @returns {{url: string, state: string, done: Promise<object>, close: () => void, settle: (result: object) => void}}
 */
export function startLogin({ port, timeoutMs = 300_000 }) {
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

  return {
    url: url.href,
    state,
    done,
    close: () => finish(new Error('DeepAI sign-in cancelled')),

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
      if (closed) {
        return {
          status: 410,
          html: callbackPage('Login expired', 'This attempt timed out. Start a new one from the dashboard.', 'error'),
          finished: true,
        };
      }
      if (req.method !== 'GET') {
        return {
          status: 405,
          html: callbackPage('Invalid callback', 'DeepAI sent an unexpected response. Start the login again from the dashboard.', 'error'),
          finished: false,
        };
      }

      const code = typeof req.query.code === 'string' ? req.query.code : '';
      const returned = typeof req.query.state === 'string' ? req.query.state : '';
      if (code === '' || code.length > 4096 || returned !== state) {
        return {
          status: 400,
          html: callbackPage('Invalid callback', 'DeepAI sent an unexpected response. Start the login again from the dashboard.', 'error'),
          finished: false,
        };
      }
      if (exchanging) {
        return {
          status: 409,
          html: callbackPage('Already in progress', 'A login is already waiting for the browser. Finish it, or cancel it in the dashboard.', 'error'),
          finished: false,
        };
      }
      exchanging = true;

      try {
        const account = await exchangeCode(code);
        finish(undefined, account);
        return {
          status: 200,
          html: callbackPage('Logged in to DeepAI', 'The gateway now has your account and can serve requests.', 'ok', { returnTo: '/' }),
          finished: true,
          account,
        };
      } catch (error) {
        finish(error);
        return {
          status: 400,
          html: callbackPage('Login failed', 'The code could not be exchanged. Return to the dashboard and try again.', 'error'),
          finished: true,
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
