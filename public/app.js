/* ==========================================================================
   DeepAI Gateway — dashboard client
   No framework: small render helpers plus a hash router.
   ========================================================================== */

const $ = (id) => document.getElementById(id);
const view = $('view');

/* ------------------------------------------------------------------- utils */

const numberFormat = new Intl.NumberFormat('en-US');

/** Compact token counts: 1234567 → 1.23M */
function tokens(value) {
  const n = Number(value) || 0;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Exact count with separators. */
function exact(value) {
  return numberFormat.format(Number(value) || 0);
}

/** Relative time: "just now", "4m ago", "3d ago". */
function ago(ms) {
  if (!ms) return '—';
  const delta = Date.now() - Number(ms);
  if (delta < 45_000) return 'just now';
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(Number(ms)).toLocaleDateString();
}

/** Absolute local date-time. */
function when(ms) {
  if (!ms) return '—';
  return new Date(Number(ms)).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** USD with enough precision for sub-cent amounts. */
function usd(value) {
  const amount = Number(value) || 0;
  if (amount === 0) return '$0.00';
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  if (amount < 1) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(2)}`;
}

/** Duration in ms → "412ms" / "1.8s". */
function duration(ms) {
  const n = Number(ms) || 0;
  if (n < 1000) return `${n}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

/** Escape text for safe insertion into HTML. */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* --------------------------------------------------------------------- api */

/** Error carrying the HTTP status, so callers can react to 401 specifically. */
class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let json;
  try {
    json = text === '' ? {} : JSON.parse(text);
  } catch {
    throw new ApiError(`Unexpected non-JSON answer (HTTP ${response.status})`, response.status);
  }
  if (!response.ok || json.ok === false) {
    throw new ApiError(json.error ?? `HTTP ${response.status}`, response.status);
  }
  return json;
}

/** Whether a failure means "the session ended". */
function isAuthFailure(error) {
  return error instanceof ApiError && error.status === 401;
}

/** Whether an origin points at the machine the browser itself is running on. */
function isLoopbackOrigin(origin) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin);
}

/**
 * The "finish signing in" step.
 *
 * DeepAI ends the sign-in by sending the browser to a `127.0.0.1` address, and
 * that address only opens on the machine running the gateway. A visitor browsing a
 * public address therefore lands on a page that cannot load — while DeepAI is
 * holding a sign-in that is still perfectly valid.
 *
 * Three states, because the same explanation is useful at different moments:
 *
 *   - **before** the visitor leaves, and only when their browser is *not* on the
 *     gateway's own host (so the failure is certain, not hypothetical): what is
 *     about to happen, and the two ways to finish it;
 *   - **while** a sign-in is waiting: the single action that finishes it;
 *   - **on the gateway's own host**: nothing, beyond a quiet fallback, because the
 *     redirect simply works there.
 *
 * @param {{pending: boolean, remote: boolean}} options
 * @returns {string} markup; every state but the last contains the paste field.
 */
function finishStep({ pending, remote }) {
  const address = state.callbackUrl;
  const prefix = address.replace(/\/auth-callback$/, '');
  const field = `
    <div class="field mt-3">
      <label class="field__label" for="callback-url">Address from that page</label>
      <textarea class="textarea" id="callback-url" rows="3" spellcheck="false" autocomplete="off"
        placeholder="${esc(address || 'http://127.0.0.1:8787/auth-callback?code=…&state=…')}"></textarea>
      <div class="field__hint">
        It starts with <code>${esc(prefix || 'http://127.0.0.1:8787')}</code> and ends with <code>state=…</code>
      </div>
    </div>
    <div class="row mt-3"><button class="btn btn--primary" id="login-complete">Finish signing in</button></div>`;

  if (pending) {
    return `
      <section class="note note--warning mt-3 step" id="finish-step" aria-labelledby="finish-title">
        <div class="step__title" id="finish-title">One more step to finish</div>
        <p class="step__lead">
          DeepAI sent your browser to an address that only opens on the server, so that page could
          not load. Your sign-in is still waiting — nothing is lost.
        </p>
        <p class="step__lead">
          Paste that page's address below.
          <span class="step__aside">Need it again? Press Forward to return to that page.</span>
        </p>
        ${field}
      </section>`;
  }

  if (remote) {
    // The visitor's browser is not on the gateway's host, so this page is the last
    // chance to explain two things before they leave: that the failure is normal,
    // and that finishing does not have to mean copy-and-paste. Fixing the host in
    // the address bar is the same rewrite the browser would have done for us — the
    // gateway serves that path on its own origin, so it just works.
    const host = (state.account?.origin ?? '').replace(/^https?:\/\//, '');
    return `
      <section class="note mt-3 step" id="finish-step" aria-labelledby="finish-title">
        <div class="step__title" id="finish-title">The last page may not load</div>
        <p class="step__lead">
          After you sign in, DeepAI sends your browser back to an address that only opens on the
          server running this gateway. If that page does not load, <strong>that is expected</strong>.
        </p>
        <p class="step__lead">Two ways to finish — either is fine:</p>
        <ul class="step__list">
          <li>Paste that page's address below.</li>
          <li>
            Or, in the address bar, replace <code>127.0.0.1</code> with
            <code>${esc(host)}</code> and press Enter.
          </li>
        </ul>
        ${field}
      </section>`;
  }

  // On the gateway's own host the redirect works, so stay out of the way and keep
  // the fallback one click away rather than explaining a problem this visitor is
  // unlikely to hit.
  return `
    <p class="card__sub mt-3" id="finish-step">
      Signed in on DeepAI already?
      <button class="linklike" id="login-reveal" type="button">Paste the address it sent you</button>
    </p>
    <div id="finish-fields" hidden>${field}</div>`;
}

/**
 * The second way in: a pasted API key.
 *
 * A key is the same credential the browser sign-in would have produced, so it
 * needs no callback, no address to copy and no password — which makes it the
 * shortest route on a gateway reached over the network.
 *
 * The email is asked for because a DeepAI key genuinely does not say who it
 * belongs to, so the name can only come from the visitor. It is a label and not a
 * credential, which is why it is described as unchecked rather than presented as a
 * fact: nothing can confirm it. `/deepai_code/theos` and `/get_usage_summary`
 * answer with allowance only, `/daily-time-sync/user/` refuses a key, and the
 * exchange needs a code. The one place a real identity appears is the browser
 * sign-in, which is why that route does not ask.
 *
 * Ownership still comes from the key, never from this field, so the name cannot be
 * used to claim another account — and it is scoped to the session that typed it.
 */
function keyForm() {
  return `
    <details class="mt-3" id="key-step">
      <summary class="card__sub step__summary">Or log in with a DeepAI API key</summary>
      <ol class="step__list mt-3">
        <li>Go to <a href="https://deepai.org/dashboard/profile" target="_blank" rel="noreferrer noopener">deepai.org/dashboard/profile</a></li>
        <li>Copy your API Key</li>
        <li>Paste it below</li>
      </ol>
      <div class="field mt-3">
        <label class="field__label" for="api-key">API Key</label>
        <input class="input" id="api-key" type="password" spellcheck="false" autocomplete="off"
          placeholder="Paste your API Key">
      </div>
      <div class="field mt-3">
        <label class="field__label" for="api-key-email">Your DeepAI email</label>
        <input class="input" id="api-key-email" type="email" spellcheck="false" autocomplete="email"
          placeholder="you@example.com">
        <div class="field__hint" id="api-key-email-hint">
          Shown as your account name. DeepAI does not say which account a key belongs to, so
          this cannot be checked — it is yours to get right.
        </div>
      </div>
      <div class="row mt-3"><button class="btn" id="login-with-key">Log In</button></div>
    </details>`;
}

/**
 * Render a view that needs a session, or a log-in prompt when there is none.
 *
 * @returns {boolean} true when the caller should stop rendering.
 */
function needsLogin() {
  if (state.account?.signedIn === true) return false;
  const pending = state.account?.pendingLogin === true;
  const origin = state.account?.origin ?? '';
  const remote = origin !== '' && !isLoopbackOrigin(origin);

  view.innerHTML = `
    <div class="page__head">
      <h1 class="page__title">Log in required</h1>
      <p class="page__sub">Keys and usage belong to the DeepAI account that created them.</p>
    </div>
    <div class="card">
      <div class="card__title">Not logged in</div>
      <div class="card__sub mt-2">Log in with DeepAI to see your API keys and usage.</div>
      <div class="row mt-3"><button class="btn btn--primary" id="login-inline">Log in with DeepAI</button></div>
      ${finishStep({ pending, remote })}
      ${keyForm()}
    </div>`;

  $('login-inline')?.addEventListener('click', () => void startLoginFlow());
  $('login-complete')?.addEventListener('click', () => void completeLoginManually());
  $('login-with-key')?.addEventListener('click', () => void signInWithKey());
  $('api-key')?.addEventListener('keydown', (event) => {
    // Enter submits, as it would in any other one-field form.
    if (event.key === 'Enter') {
      event.preventDefault();
      void signInWithKey();
    }
  });
  $('login-reveal')?.addEventListener('click', () => {
    const fields = $('finish-fields');
    if (fields) fields.hidden = false;
    $('login-reveal')?.parentElement?.remove();
    $('callback-url')?.focus();
  });
  // A waiting sign-in is the moment to type, so put the caret where it is needed.
  if (pending) $('callback-url')?.focus();
  return true;
}

/**
 * Sign in with a pasted DeepAI API key.
 *
 * Both secrets are cleared from the fields once they have been accepted, so they
 * do not linger in the page after they are no longer needed.
 */
async function signInWithKey() {
  const field = $('api-key');
  const emailField = $('api-key-email');
  const key = field?.value?.trim() ?? '';
  const email = emailField?.value?.trim() ?? '';
  if (key === '') {
    toast('Paste your API Key first.', 'error');
    field?.focus();
    return;
  }
  if (email === '') {
    toast('Add the email to show as your account name.', 'error');
    emailField?.focus();
    return;
  }

  const button = $('login-with-key');
  const label = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = 'Checking…';
  }
  try {
    await api('/login/key', { method: 'POST', body: { key, email } });
    if (field) field.value = '';
    if (emailField) emailField.value = '';
    toast('Logged in');
    await loadAccount();
    await render();
  } catch (error) {
    toast(String(error.message ?? error), 'error');
    if (button) {
      button.disabled = false;
      button.textContent = label ?? 'Log In';
    }
    field?.focus();
    field?.select();
  }
}

/**
 * Send back the address the failed page was sitting on.
 *
 * The gateway checks it against the sign-in this browser started and redeems the
 * one-shot code in it, exactly as the callback route would have. On success the
 * visitor is simply logged in, so the step disappears with the rest of the card.
 */
async function completeLoginManually() {
  const field = $('callback-url');
  const url = field?.value?.trim() ?? '';
  if (url === '') {
    toast('Copy the address from the page that did not load, then paste it here.', 'error');
    field?.focus();
    return;
  }

  const button = $('login-complete');
  const label = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = 'Signing in…';
  }
  try {
    await api('/login/complete', { method: 'POST', body: { url } });
    toast('Signed in to DeepAI');
    await loadAccount();
    await render();
  } catch (error) {
    toast(String(error.message ?? error), 'error');
    if (button) {
      button.disabled = false;
      button.textContent = label ?? 'Finish signing in';
    }
    // The address is the only thing that can be wrong, so make it easy to retry.
    field?.focus();
    field?.select();
  }
}

/* ------------------------------------------------------------------ toasts */

function toast(message, kind = 'ok') {
  const node = document.createElement('div');
  node.className = kind === 'error' ? 'toast toast--error' : 'toast';
  node.textContent = message;
  $('toasts').appendChild(node);
  setTimeout(() => node.remove(), kind === 'error' ? 6000 : 3200);
}

/* ------------------------------------------------------------------- modal */

let modalOnClose = undefined;

function openModal(title, bodyNode, onClose) {
  $('modal-title').textContent = title;
  const body = $('modal-body');
  body.replaceChildren(bodyNode);
  $('modal').hidden = false;
  modalOnClose = onClose;
  const focusable = body.querySelector('input, select, textarea, button');
  focusable?.focus();
}

function closeModal() {
  $('modal').hidden = true;
  $('modal-body').replaceChildren();
  const callback = modalOnClose;
  modalOnClose = undefined;
  callback?.();
}

$('modal-close').addEventListener('click', closeModal);
$('modal').addEventListener('click', (event) => {
  if (event.target === $('modal')) closeModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('modal').hidden) closeModal();
});

/** Small helper to build a form field. */
function field(label, control, hint) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const labelNode = document.createElement('label');
  labelNode.className = 'field__label';
  labelNode.textContent = label;
  wrap.appendChild(labelNode);
  wrap.appendChild(control);
  if (hint) {
    const hintNode = document.createElement('span');
    hintNode.className = 'field__hint';
    hintNode.textContent = hint;
    wrap.appendChild(hintNode);
  }
  return wrap;
}

/** Copy text to the clipboard with feedback. */
async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      const original = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = original; }, 1400);
    } else {
      toast('Copied to clipboard');
    }
  } catch {
    toast('Could not copy — select the text manually.', 'error');
  }
}

/** A code snippet with a copy affordance. */
function snippet(text) {
  const wrap = document.createElement('div');
  wrap.className = 'snippet';
  const code = document.createElement('code');
  code.textContent = text;
  const button = document.createElement('button');
  button.className = 'snippet__copy';
  button.textContent = 'Copy';
  button.addEventListener('click', () => copy(text, button));
  wrap.append(code, button);
  return wrap;
}

/* ------------------------------------------------------------------ theme */

const THEME_KEY = 'deepai-gateway-theme';
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

/**
 * Apply a theme.
 *
 * Only an explicit choice is stored. Persisting the value on load would freeze
 * the system preference into a permanent override on the first visit, so the
 * dashboard — and the sign-in screen, which reads the same key — would stop
 * following the OS.
 *
 * @param {'light'|'dark'|'system'} theme
 */
function applyTheme(theme) {
  if (theme === 'system') {
    delete document.documentElement.dataset.theme;
    localStorage.removeItem(THEME_KEY);
  } else {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }
  // The header logo follows the theme in CSS, but a favicon cannot be reached
  // from a stylesheet, so the tab icon is the one thing that has to be told.
  syncFavicon();
}

/**
 * Point the tab icon at the mark that is visible against the current theme.
 *
 * The artwork is one glyph in white and black, so the wrong one is invisible
 * rather than merely off-brand.
 */
function syncFavicon() {
  const favicon = $('favicon');
  if (favicon === null) return;
  favicon.href = effectiveTheme() === 'dark' ? '/icon-32.png' : '/icon-black-32.png';
}

/** The theme actually in effect right now. */
function effectiveTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return prefersDark.matches ? 'dark' : 'light';
}

applyTheme(localStorage.getItem(THEME_KEY) ?? 'system');

// While no explicit choice is stored, follow the OS as it changes.
prefersDark.addEventListener('change', () => {
  if (localStorage.getItem(THEME_KEY) === null) applyTheme('system');
});

$('theme-toggle').addEventListener('click', () => {
  applyTheme(effectiveTheme() === 'dark' ? 'light' : 'dark');
});

$('auth-button').addEventListener('click', () => { void onAuthButton(); });

/* ------------------------------------------------------------- shared state */

const state = {
  account: undefined,
  models: [],
  // The loopback address DeepAI will send this browser to. DeepAI chooses the
  // host itself, so it is only ever shown to the visitor as the address to copy
  // when their browser cannot open it.
  callbackUrl: '',
};

/**
 * What to call the signed-in account.
 *
 * `displayName` is the visitor's own name for the account — the email they gave
 * when signing in with a key, or the DeepAI username the sign-in returned. The
 * fallback is the owner id, which is a key fingerprint and only ever shown when
 * nothing better is known.
 *
 * @param {object|undefined} account
 * @returns {string}
 */
function accountName(account) {
  const display = typeof account?.displayName === 'string' ? account.displayName.trim() : '';
  if (display !== '') return display;
  const username = typeof account?.username === 'string' ? account.username.trim() : '';
  return username !== '' ? username : 'DeepAI user';
}

/**
 * Render the account pill and the single auth button in the top bar.
 *
 * One control, two states: "Log in" while logged out, a filled red
 * "Log out" while logged in.
 */
function renderAccountBadge() {
  const badge = $('account-badge');
  const text = $('account-badge-text');
  const button = $('auth-button');
  const account = state.account;

  if (account === undefined) {
    badge.className = 'badge badge--gray';
    text.textContent = 'Checking…';
    button.hidden = true;
    return;
  }

  button.hidden = false;
  if (account.signedIn) {
    badge.className = account.balanceLow ? 'badge badge--amber' : 'badge badge--green';
    const balance = account.allowance?.balance;
    text.textContent = balance
      ? `${accountName(account)} · ${balance} Theos`
      : accountName(account);
    button.textContent = 'Log out';
    button.className = 'btn btn--sm btn--signout';
  } else {
    badge.className = 'badge badge--red';
    text.textContent = 'Logged out';
    button.textContent = 'Log in';
    button.className = 'btn btn--sm btn--signin';
  }
}

/** The single top-bar auth action. */
async function onAuthButton() {
  if (state.account?.signedIn === true) {
    await logOutEverywhere();
    return;
  }
  await startLoginFlow();
}

/**
 * Start the DeepAI login in **this** tab.
 *
 * Navigating the current tab rather than opening a popup means DeepAI returns
 * the browser to the dashboard when it is done, so there is no second window to
 * chase and nothing to close. `/login?json=1` is asked first so a failure is
 * reported here instead of replacing the page with an error.
 *
 * DeepAI then redirects to a loopback address of its own choosing, which this
 * browser can only open when it runs on the gateway's host. The address is kept
 * so the dashboard can show it as the thing to copy when that fails.
 */
async function startLoginFlow() {
  const buttons = [$('auth-button'), $('signin'), $('login-inline')].filter(Boolean);
  for (const button of buttons) {
    button.disabled = true;
    button.dataset.label = button.textContent;
    button.textContent = 'Redirecting…';
  }
  try {
    const payload = await api('/login', { method: 'POST' });
    state.callbackUrl = payload.callbackUrl ?? '';
    // Full navigation, not window.open: the callback lands back on the panel.
    window.location.assign(payload.url);
    return;
  } catch (error) {
    for (const button of buttons) {
      button.disabled = false;
      button.textContent = button.dataset.label ?? 'Log in';
    }
    toast(String(error.message ?? error), 'error');
  }
}

/** Log out and repaint the current view. */
async function logOutEverywhere() {
  try {
    await api('/logout', { method: 'POST' });
    toast('Logged out');
  } catch (error) {
    toast(String(error.message ?? error), 'error');
  }
  await loadAccount();
  await render();
}

/** Load the account once and keep the badge in sync. */
async function loadAccount() {
  try {
    state.account = await api('/account');
    // The server derives this from the request the dashboard was served on, so it
    // stays correct across a reload — which is exactly when the visitor comes back
    // from the callback address their browser could not open.
    state.callbackUrl = state.account.callbackUrl ?? '';
  } catch (error) {
    state.account = { signedIn: false, username: '', error: String(error.message ?? error) };
  }
  renderAccountBadge();
}

/** Load the model catalog once. */
async function loadModels(force = false) {
  if (!force && state.models.length > 0) return state.models;
  const payload = await api('/models');
  state.models = payload.models ?? [];
  return state.models;
}

/* ------------------------------------------------------------------- views */

const routes = {
  home: renderHome,
  models: renderModels,
  keys: renderKeys,
};

/** A metric card. */
function metricCard({ eyebrow, value, label, foot }) {
  return `
    <div class="card">
      <div class="eyebrow">${esc(eyebrow)}</div>
      <div class="metric__value mt-2">${value}</div>
      <div class="metric__label">${esc(label)}</div>
      ${foot ? `<div class="metric__foot">${foot}</div>` : ''}
    </div>`;
}

/** A 14-day token sparkline. */
function sparkline(daily) {
  const max = Math.max(1, ...daily.map((day) => day.tokens));
  const peak = daily.reduce((best, day) => (day.tokens > best.tokens ? day : best), daily[0]);
  return `
    <div class="spark" title="Tokens per day, last 14 days">
      ${daily.map((day) => {
        const height = Math.max(2, Math.round((day.tokens / max) * 44));
        const isPeak = day === peak && peak.tokens > 0;
        return `<div class="spark__bar" data-peak="${isPeak}" style="height:${height}px"
          title="${esc(day.label)} · ${exact(day.tokens)} tokens · ${exact(day.requests)} requests"></div>`;
      }).join('')}
    </div>`;
}

/** Usage table for a per-model breakdown; hides models without usage. */
function modelUsageRows(models, emptyText) {
  const used = models.filter((model) => model.requests > 0 && model.totalTokens > 0);
  if (used.length === 0) {
    return `<tr><td colspan="4"><div class="empty"><div class="empty__title">No usage yet</div>${esc(emptyText)}</div></td></tr>`;
  }
  const max = Math.max(...used.map((model) => model.totalTokens));
  return used.map((model) => `
    <tr>
      <td>
        <div class="model-row__name truncate">${esc(model.model)}</div>
        <div class="tiny muted">last used ${esc(ago(model.lastUsedAt))}</div>
      </td>
      <td class="num">${exact(model.requests)}</td>
      <td class="num">${exact(model.totalTokens)}</td>
      <td style="width:120px">
        <div class="bar"><div class="bar__fill" style="width:${Math.round((model.totalTokens / max) * 100)}%"></div></div>
      </td>
    </tr>`).join('');
}

/**
 * Whether a model is on the paid tier, from the cached catalog.
 * Unknown models (removed from the catalog since) are left unmarked rather than
 * guessed at.
 */
function isPremiumModel(modelId) {
  const model = state.models.find((entry) => entry.id === modelId);
  return model === undefined ? undefined : model.premier === true;
}

/** Requests table. */
function requestRows(requests, showKey = true) {
  if (requests.length === 0) {
    return `<tr><td colspan="${showKey ? 7 : 6}"><div class="empty"><div class="empty__title">No requests yet</div>Send a request to <code>/v1/chat/completions</code> to see it here.</div></td></tr>`;
  }
  return requests.map((item) => {
    const premium = isPremiumModel(item.model);
    return `
    <tr>
      <td class="tiny muted" title="${esc(when(item.createdAt))}">${esc(ago(item.createdAt))}</td>
      <td class="truncate" style="max-width:180px">
        <span class="row" style="gap:6px">
          <span class="truncate">${esc(item.model)}</span>
          ${premium === true
            ? '<span class="badge badge--violet" title="Billed in Theos">Premium</span>'
            : premium === false
              ? '<span class="badge badge--gray" title="Unmetered">Free</span>'
              : ''}
        </span>
      </td>
      ${showKey ? `<td class="truncate tiny" style="max-width:130px">${esc(item.keyName || '—')}</td>` : ''}
      <td class="num">${item.totalTokens > 0 ? exact(item.totalTokens) : '—'}</td>
      <td class="num tiny muted">${item.inputTokens}/${item.outputTokens}${item.reasoningTokens > 0 ? `<span title="reasoning tokens"> · r${tokens(item.reasoningTokens)}</span>` : ''}</td>
      <td class="num tiny muted">${esc(duration(item.durationMs))}</td>
      <td>${item.ok
        ? `<span class="badge badge--green"><span class="dot"></span>${item.status}</span>`
        : `<span class="badge badge--red" title="${esc(item.errorCode ?? '')}">${item.status || 'error'}</span>`}</td>
    </tr>`;
  }).join('');
}

/** Sign-in / account card, shared by the overview. */
function accountCard() {
  const account = state.account ?? {};
  if (!account.signedIn) {
    return `
      <div class="card">
        <div class="row row--between">
          <div>
            <div class="card__title">DeepAI account</div>
            <div class="card__sub">The gateway needs your DeepAI account to reach the models.</div>
          </div>
          <span class="badge badge--red"><span class="dot"></span>Not signed in</span>
        </div>
        <div class="mt-3 stack">
          <div class="note">Log in with the same browser flow the DeepAI desktop app uses. The account key is stored in the gateway database and never leaves this machine.</div>
          <div class="row"><button class="btn btn--primary" id="signin">Log in with DeepAI</button></div>
          <div class="tiny muted">The same control lives in the top bar.</div>
        </div>
      </div>`;
  }
  const allowance = account.allowance;
  const balance = Number(allowance?.balance);
  const granted = Number(allowance?.granted);
  const used = Number.isFinite(balance) && Number.isFinite(granted) ? Math.max(0, granted - balance) : undefined;
  const pct = Number.isFinite(used) && granted > 0 ? Math.min(100, Math.round((used / granted) * 100)) : undefined;

  return `
    <div class="card">
      <div class="row row--between">
        <div>
          <div class="card__title">DeepAI account</div>
          <div class="card__sub">Logged in as ${esc(accountName(account))}${account.isPro ? ' · Pro' : ''}</div>
        </div>
        <span class="badge ${account.balanceLow ? 'badge--amber' : 'badge--green'}"><span class="dot"></span>${account.balanceLow ? 'Low balance' : 'Active'}</span>
      </div>
      ${allowance && allowance.balance !== null ? `
        <div class="mt-3">
          <div class="row row--between tiny muted">
            <span>Theos balance</span>
            <span class="mono">${esc(allowance.balance)} / ${esc(allowance.granted ?? '—')}</span>
          </div>
          ${pct !== undefined ? `<div class="bar mt-2"><div class="bar__fill ${account.balanceLow ? 'bar__fill--warn' : ''}" style="width:${pct}%"></div></div>` : ''}
          <div class="tiny muted mt-2">Resets ${esc(allowance.refreshAt ? when(Date.parse(allowance.refreshAt)) : '—')}</div>
        </div>` : ''}
      <div class="row mt-3 row--wrap">
        <button class="btn btn--secondary btn--sm" id="refresh-allowance">Refresh balance</button>
        <button class="btn btn--ghost btn--sm" id="forget-account">Forget this account</button>
        <span class="spacer"></span>
        <span class="tiny muted">${esc(keyQuotaLabel(account.keyQuota))}</span>
      </div>
      <div class="tiny muted mt-2">
        This browser's session ends ${esc(account.sessionExpiresAt ? when(account.sessionExpiresAt) : 'never')}.
        Logging out ends only this session; the DeepAI account and its keys stay, so other browsers keep working.
      </div>
      <div class="tiny muted mt-2" id="auth-events"></div>
    </div>`;
}

/** One-line summary of the key quota. */
function keyQuotaLabel(quota) {
  if (quota === undefined || quota === null) return '';
  return `${quota.used} of ${quota.max} API keys used`;
}

/** Fill the small auth-event list inside the account card. */
async function loadAuthEvents() {
  const target = $('auth-events');
  if (target === null) return;
  try {
    const { events } = await api('/account/events?limit=4');
    if (events.length === 0) {
      target.textContent = '';
      return;
    }
    target.innerHTML = `Last activity: ${events
      .map((event) => `${esc(event.event)} ${esc(ago(event.createdAt))}`)
      .join(' · ')}`;
  } catch {
    target.textContent = '';
  }
}

/**
 * "Money saved" panel.
 *
 * Prices the same token counts against the public APIs these models mirror, so
 * the number answers "what would this traffic have cost elsewhere".
 */
function savingsCard(savings) {
  if (savings === undefined) return '';
  const { month, today, all } = savings;
  const unpriced = month.unpricedModels ?? [];
  const pricing = savings.pricing ?? {};
  const live = pricing.source === 'live';
  const asOf = pricing.capturedAt ? new Date(pricing.capturedAt).toLocaleString() : 'unknown';

  const rows = month.perModel
    .filter((entry) => entry.tokens > 0)
    .slice(0, 6)
    .map((entry) => `
      <tr>
        <td class="truncate" style="max-width:200px">${esc(entry.model)}</td>
        <td class="num">${tokens(entry.tokens)}</td>
        <td class="num">${entry.priced ? esc(usd(entry.usd)) : '<span class="muted" title="No public equivalent">n/a</span>'}</td>
      </tr>`)
    .join('');

  return `
    <div class="card">
      <div class="row row--between">
        <div>
          <div class="card__title">Money saved</div>
          <div class="card__sub">What this traffic would cost on the public APIs these models mirror.</div>
        </div>
        <div class="row" style="gap:8px">
          <span class="badge ${live ? 'badge--green' : 'badge--amber'}"
                title="${esc(live ? 'Live rates from OpenRouter' : `Using ${pricing.source ?? 'bundled'} rates`)}">
            <span class="dot"></span>${live ? 'Live rates' : 'Cached rates'}
          </span>
          <span class="badge badge--gray">${esc(usd(month.usd))} this month</span>
        </div>
      </div>

      <div class="grid grid--3 mt-3">
        <div>
          <div class="eyebrow">Today</div>
          <div class="metric__value" style="font-size:22px">${esc(usd(today.usd))}</div>
        </div>
        <div>
          <div class="eyebrow">This month</div>
          <div class="metric__value" style="font-size:22px">${esc(usd(month.usd))}</div>
        </div>
        <div>
          <div class="eyebrow">All time</div>
          <div class="metric__value" style="font-size:22px">${esc(usd(all.usd))}</div>
        </div>
      </div>

      ${rows === '' ? '' : `
        <div class="table-wrap mt-3">
          <table class="table">
            <thead><tr><th>Model</th><th class="num">Tokens</th><th class="num">Equivalent</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`}

      <div class="row row--between mt-3">
        <p class="tiny muted" style="margin:0;max-width:70ch">
          Priced against published OpenRouter rates, fetched ${esc(asOf)}.
          ${unpriced.length > 0
            ? `Not priced: ${unpriced.map((model) => esc(model)).join(', ')} (no public equivalent).`
            : ''}
          Cache reads and writes use each model's own cache rate where one is published.
        </p>
        <button class="btn btn--secondary btn--sm" id="refresh-pricing">Refresh rates</button>
      </div>
    </div>`;
}

/** Wire the account card buttons. */
function wireAccountCard(rerender) {
  $('signin')?.addEventListener('click', () => void startLoginFlow());

  $('refresh-allowance')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Refreshing…';
    try {
      const result = await api('/account/refresh', { method: 'POST' });
      if (result.ok) toast(`Balance: ${result.allowance.balance} Theos`);
      else toast(result.error ?? 'Could not refresh', 'error');
    } catch (error) {
      toast(String(error.message ?? error), 'error');
    }
    await loadAccount();
    rerender();
  });

  // "Log out" only ends this browser's session. Removing the account is a
  // separate, destructive decision, so it gets its own confirm step.
  $('forget-account')?.addEventListener('click', async () => {
    const username = accountName(state.account);
    const confirmed = window.confirm(
      `Remove the DeepAI account "${username}" from this gateway?\n\n`
      + 'Its API keys will be deleted and its DeepAI credential forgotten. '
      + 'Usage history is kept. This cannot be undone.',
    );
    if (!confirmed) return;
    try {
      await api('/account/forget', { method: 'POST' });
      toast('Account removed');
      await loadAccount();
      await render();
    } catch (error) {
      toast(String(error.message ?? error), 'error');
    }
  });
}

/* -------------------------------------------------------------------- home */

async function renderHome() {
  if (needsLogin()) return;
  view.innerHTML = '<div class="loading"><span class="spinner"></span>Loading usage…</div>';

  let data;
  try {
    data = await api('/usage/summary');
  } catch (error) {
    if (isAuthFailure(error)) {
      await loadAccount();
      if (needsLogin()) return;
    }
    view.innerHTML = `<div class="note note--error">Could not load usage: ${esc(error.message)}</div>`;
    return;
  }
  const recent = await api('/usage/recent?limit=20').catch(() => ({ requests: [] }));

  const { today, month, all } = data;
  const modelsUsedMonth = data.modelsMonth.filter((model) => model.totalTokens > 0);

  view.innerHTML = `
    <div class="page__head">
      <h1 class="page__title">Overview</h1>
      <p class="page__sub">Gateway traffic, token accounting and the DeepAI account behind it. Totals are read from the same table that serves every other view.</p>
    </div>

    <div class="stack">
      <div class="grid grid--4">
        ${metricCard({
          eyebrow: 'Tokens this month',
          value: tokens(month.totalTokens),
          label: 'Total tokens across all keys',
          foot: `${exact(month.requests)} requests · ${exact(month.failedRequests)} failed`,
        })}
        ${metricCard({
          eyebrow: 'Tokens today',
          value: tokens(today.totalTokens),
          label: 'Since local midnight',
          foot: `${exact(today.requests)} requests · ${exact(today.failedRequests)} failed`,
        })}
        ${metricCard({
          eyebrow: 'All time',
          value: tokens(all.totalTokens),
          label: 'Every request recorded',
          foot: `${exact(all.requests)} requests · avg ${esc(duration(all.avgDurationMs))}`,
        })}
        ${metricCard({
          eyebrow: 'Cache reads',
          value: tokens(month.cacheReadTokens),
          label: 'Input tokens served from cache this month',
          foot: `reasoning ${exact(month.reasoningTokens)} · cache writes ${exact(month.cacheWriteTokens)}`,
        })}
      </div>

      ${savingsCard(data.savings)}

      <div class="grid grid--main">
        <div class="stack">
          <div class="card card--flush">
            <div class="card__head">
              <div>
                <div class="card__title">Token usage by model</div>
                <div class="card__sub">This month. Models without usage are hidden.</div>
              </div>
              <span class="badge badge--gray">${modelsUsedMonth.length} active</span>
            </div>
            <div class="table-wrap">
              <table class="table">
                <thead><tr>
                  <th>Model</th><th class="num">Requests</th><th class="num">Tokens</th><th></th>
                </tr></thead>
                <tbody>${modelUsageRows(data.modelsMonth, 'Models appear here once a request uses them.')}</tbody>
              </table>
            </div>
          </div>

          <div class="card card--flush">
            <div class="card__head">
              <div>
                <div class="card__title">Recent requests</div>
                <div class="card__sub">Newest first, including failures.</div>
              </div>
              <div class="row" style="gap:6px">
                <a class="btn btn--ghost btn--sm" href="/api/usage/export?format=csv" download>Export CSV</a>
                <a class="btn btn--ghost btn--sm" href="#/keys">Manage keys</a>
              </div>
            </div>
            <div class="table-wrap">
              <table class="table">
                <thead><tr>
                  <th>When</th><th>Model</th><th>Key</th><th class="num">Tokens</th>
                  <th class="num hide-sm">In/Out</th><th class="num hide-sm">Time</th><th>Status</th>
                </tr></thead>
                <tbody>${requestRows(recent.requests, true)}</tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="stack">
          ${accountCard()}

          <div class="card">
            <div class="eyebrow">Last 14 days</div>
            <div class="mt-3">${sparkline(data.daily)}</div>
            <div class="row row--between tiny muted mt-2">
              <span>${esc(data.daily[0]?.label ?? '')}</span>
              <span>${esc(data.daily.at(-1)?.label ?? '')}</span>
            </div>
          </div>

          <div class="card">
            <div class="eyebrow">Use it</div>
            <div class="tiny muted mt-2">Point any OpenAI client at this gateway.</div>
            <div class="stack mt-3" id="home-snippets"></div>
          </div>
        </div>
      </div>
    </div>`;

  // Snippets need real nodes so their copy buttons work.
  const useIt = $('home-snippets');
  const base = `${location.origin}/v1`;
  useIt.appendChild(snippet(`OPENAI_BASE_URL=${base}\nOPENAI_API_KEY=sk-…`));
  useIt.appendChild(snippet(`curl ${base}/chat/completions \\\n  -H "Authorization: Bearer sk-…" \\\n  -H "content-type: application/json" \\\n  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}]}'`));

  wireAccountCard(() => renderHome());
  if (state.account?.signedIn) void loadAuthEvents();

  $('refresh-pricing')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Refreshing…';
    try {
      const result = await api('/pricing/refresh', { method: 'POST' });
      toast(result.ok ? `Rates refreshed (${result.matched.length} models)` : `Refresh failed: ${result.error}`, result.ok ? 'ok' : 'error');
    } catch (error) {
      toast(String(error.message ?? error), 'error');
    }
    renderHome();
  });
}

/* ------------------------------------------------------------------ models */

async function renderModels() {
  view.innerHTML = '<div class="loading"><span class="spinner"></span>Loading models…</div>';
  let payload;
  try {
    payload = await api('/models');
  } catch (error) {
    view.innerHTML = `<div class="note note--error">Could not load models: ${esc(error.message)}</div>`;
    return;
  }
  const models = payload.models ?? [];
  state.models = models;

  const free = models.filter((model) => !model.premier);
  const premier = models.filter((model) => model.premier);

  const row = (model) => `
    <tr>
      <td>
        <div class="model-row">
          <div>
            <div class="model-row__name">${esc(model.displayName)}</div>
            <div class="tiny muted mono">${esc(model.id)}</div>
          </div>
        </div>
      </td>
      <td><span class="badge ${model.premier ? 'badge--violet' : 'badge--green'}">${model.premier ? 'Premium' : 'Free'}</span></td>
      <td class="num tiny muted">${esc(tokens(model.contextWindow))}</td>
      <td class="num tiny muted">${esc(tokens(model.maxTokens))}</td>
      <td class="tiny muted">${model.reasoning ? 'none · low · medium · high' : '—'}</td>
      <td class="tiny muted">${model.input.includes('image') ? 'text, image' : 'text'}</td>
      <td class="num tiny muted">${model.premier ? esc(model.rateLabel) : 'Unmetered'}</td>
      <td class="num tiny">${model.usageMonth ? exact(model.usageMonth.totalTokens) : '<span class="muted">—</span>'}</td>
    </tr>`;

  view.innerHTML = `
    <div class="page__head">
      <h1 class="page__title">Models</h1>
      <p class="page__sub">The DeepAI Code catalog. Free models are unmetered; Premium models draw on your Theos balance per second of generation. Rates shown are for the default thinking level.</p>
    </div>

    <div class="stack">
      <div class="grid grid--3">
        ${metricCard({ eyebrow: 'Catalog', value: String(models.length), label: 'Models available' })}
        ${metricCard({ eyebrow: 'Free tier', value: String(free.length), label: 'Unmetered models' })}
        ${metricCard({ eyebrow: 'Premium', value: String(premier.length), label: 'Billed in Theos' })}
      </div>

      <div class="card card--flush">
        <div class="card__head">
          <div>
            <div class="card__title">All models</div>
            <div class="card__sub">Tokens used shows this month's traffic through the gateway.</div>
          </div>
          <button class="btn btn--secondary btn--sm" id="reload-models">Reload catalog</button>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr>
              <th>Model</th><th>Tier</th><th class="num">Context</th><th class="num">Max out</th>
              <th class="hide-sm">Reasoning</th><th class="hide-sm">Input</th><th class="num">Rate</th><th class="num">Used</th>
            </tr></thead>
            <tbody>${models.map(row).join('')}</tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="eyebrow">How billing works</div>
        <p class="muted mt-2" style="font-size:13px;max-width:78ch">
          Free models cost nothing and are marked <strong>Free</strong> in the picker. Premium models are charged in
          Theos per second of generation, at a rate that depends on the thinking level — <code>high</code> is the
          cheapest per second because the model works longer but at a lower rate. The balance shown on the overview
          page is the account allowance reported by DeepAI.
        </p>
      </div>
    </div>`;

  $('reload-models').addEventListener('click', async () => {
    await loadModels(true);
    toast('Catalog reloaded');
    renderModels();
  });
}

/* -------------------------------------------------------------------- keys */

async function renderKeys() {
  if (needsLogin()) return;
  view.innerHTML = '<div class="loading"><span class="spinner"></span>Loading keys…</div>';
  let payload;
  try {
    payload = await api('/keys');
  } catch (error) {
    if (isAuthFailure(error)) {
      await loadAccount();
      if (needsLogin()) return;
    }
    view.innerHTML = `<div class="note note--error">Could not load keys: ${esc(error.message)}</div>`;
    return;
  }
  const keys = payload.keys ?? [];
  const quota = payload.quota ?? { used: keys.length, max: 5, remaining: 0, atLimit: false };

  const limitCell = (key) => {
    const parts = [];
    if (key.limitTokens !== null) {
      const pct = Math.min(100, Math.round((key.usage.totalTokens / key.limitTokens) * 100));
      parts.push(`
        <div class="tiny mono">${exact(key.usage.totalTokens)} / ${exact(key.limitTokens)} tokens</div>
        <div class="bar mt-2"><div class="bar__fill ${pct >= 100 ? 'bar__fill--over' : pct >= 80 ? 'bar__fill--warn' : ''}" style="width:${pct}%"></div></div>`);
    }
    if (key.limitRequests !== null) {
      const pct = Math.min(100, Math.round((key.usage.requests / key.limitRequests) * 100));
      parts.push(`
        <div class="tiny mono mt-2">${exact(key.usage.requests)} / ${exact(key.limitRequests)} requests</div>
        <div class="bar mt-2"><div class="bar__fill ${pct >= 100 ? 'bar__fill--over' : pct >= 80 ? 'bar__fill--warn' : ''}" style="width:${pct}%"></div></div>`);
    }
    if (parts.length === 0) return '<span class="tiny muted">Unlimited</span>';
    const windowLabel = key.limitWindow === 'total' ? 'in total' : `per ${esc(key.limitWindow)}`;
    return `${parts.join('')}<div class="tiny muted mt-2">${windowLabel}</div>`;
  };

  const statusBadge = (status) => {
    const map = {
      active: 'badge--green', limited: 'badge--amber', expired: 'badge--amber', revoked: 'badge--red',
    };
    return `<span class="badge ${map[status] ?? 'badge--gray'}"><span class="dot"></span>${esc(status)}</span>`;
  };

  const modelCell = (key) => {
    if (key.modelsRestricted !== true) return '<span class="tiny muted">All models</span>';
    if (key.allowedModels.length === 0) return '<span class="badge badge--red">None</span>';
    return `<span class="tiny muted">${key.allowedModels.length} allowed</span>`;
  };

  const row = (key) => `
    <tr>
      <td>
        <div class="model-row__name">${esc(key.name)}</div>
        <div class="tiny muted mono">${esc(key.prefix)}…</div>
      </td>
      <td class="tiny muted">${esc(key.owner || '—')}</td>
      <td>${statusBadge(key.status)}</td>
      <td class="tiny muted">${key.expiresAt === null ? 'Never' : esc(when(key.expiresAt))}</td>
      <td>${modelCell(key)}</td>
      <td style="min-width:170px">${limitCell(key)}</td>
      <td class="tiny muted hide-sm">${esc(ago(key.lastUsedAt))}</td>
      <td>
        <div class="row" style="gap:6px">
          <button class="btn btn--secondary btn--sm" data-action="edit" data-id="${esc(key.id)}">Edit</button>
          <button class="btn btn--danger-ghost btn--sm" data-action="revoke" data-id="${esc(key.id)}">Revoke</button>
        </div>
      </td>
    </tr>`;

  view.innerHTML = `
    <div class="page__head">
      <h1 class="page__title">API Keys</h1>
      <p class="page__sub">Keys are shown once at creation; only a SHA-256 hash is stored. Limits are enforced per key inside its own window.</p>
    </div>

    <div class="stack">
      <div class="row row--between">
        <span class="eyebrow">${keys.length} of ${quota.max} keys used</span>
        <button class="btn btn--primary" id="new-key" ${quota.atLimit ? 'disabled title="Revoke a key first"' : ''}>Create key</button>
      </div>

      ${quota.atLimit
        ? `<div class="note note--warning">This account holds the maximum of ${quota.max} keys. Revoke one to create another.</div>`
        : ''}

      <div class="card card--flush">
        <div class="table-wrap">
          <table class="table">
            <thead><tr>
              <th>Key</th><th>Owner</th><th>Status</th><th>Expires</th><th>Models</th><th>Limits</th>
              <th class="hide-sm">Last used</th><th></th>
            </tr></thead>
            <tbody>${keys.length === 0
              ? `<tr><td colspan="8"><div class="empty"><div class="empty__title">No API keys yet</div>${
                  state.account?.signedIn === true
                    ? 'Create one to start sending requests.'
                    : 'Log in to create one.'
                }</div></td></tr>`
              : keys.map(row).join('')}</tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="eyebrow">Authenticate</div>
        <div class="tiny muted mt-2">Every <code>/v1</code> request needs a key. <code>/v1/models</code> lists only the models that key may use.</div>
        <div class="mt-3 stack" id="auth-snippets"></div>
      </div>
    </div>`;

  const base = `${location.origin}/v1`;
  const snippets = $('auth-snippets');
  snippets.appendChild(snippet(`curl ${base}/chat/completions \\\n  -H "Authorization: Bearer sk-…" \\\n  -H "content-type: application/json" \\\n  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}]}'`));
  snippets.appendChild(snippet(`OPENAI_BASE_URL=${base}\nOPENAI_API_KEY=sk-…`));

  $('new-key').addEventListener('click', () => openKeyModal(undefined, renderKeys));

  view.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.id;
      const action = button.dataset.action;
      const key = keys.find((item) => item.id === id);
      if (action === 'edit') {
        openKeyModal(key, renderKeys);
        return;
      }

      if (action === 'revoke') {
        if (!confirm(
          `Revoke the key "${key.name}"?\n\n`
          + 'The key is deleted and stops working immediately. This cannot be undone, '
          + 'and you will need a new key to keep using the API.\n\n'
          + 'Usage already recorded is kept.',
        )) return;
        await api(`/keys/${id}/revoke`, { method: 'POST' });
        toast('Key revoked');
        return renderKeys();
      }
    });
  });
}

/** Create/edit dialog for one key. */
function openKeyModal(existing, onDone) {
  const form = document.createElement('div');
  form.className = 'stack';

  const name = document.createElement('input');
  name.className = 'input';
  name.placeholder = 'Production app';
  name.value = existing?.name ?? '';

  // --- Limits -------------------------------------------------------------
  // `unlimited` is the default: no token or request cap at all.
  const window_ = document.createElement('select');
  window_.className = 'select';
  for (const [value, label] of [
    ['unlimited', 'Unlimited'],
    ['hour', 'Per hour'],
    ['day', 'Per day'],
    ['month', 'Per month'],
    ['total', 'Total (never resets)'],
  ]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    window_.appendChild(option);
  }
  window_.value = existing?.limitWindow ?? 'unlimited';

  const limitTokens = document.createElement('input');
  limitTokens.className = 'input';
  limitTokens.type = 'number';
  limitTokens.min = '0';
  limitTokens.placeholder = 'No limit';
  limitTokens.value = existing?.limitTokens ?? '';

  const limitRequests = document.createElement('input');
  limitRequests.className = 'input';
  limitRequests.type = 'number';
  limitRequests.min = '0';
  limitRequests.placeholder = 'No limit';
  limitRequests.value = existing?.limitRequests ?? '';

  const tokensField = field('Token limit', limitTokens, 'Leave empty for no token cap.');
  const requestsField = field('Request limit', limitRequests, 'Leave empty for no request cap.');

  // --- Expiry -------------------------------------------------------------
  const expiryMode = document.createElement('select');
  expiryMode.className = 'select';
  for (const [value, label] of [['never', 'Never'], ['date', 'On a date']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    expiryMode.appendChild(option);
  }
  expiryMode.value = existing?.expiresAt ? 'date' : 'never';

  const expiryDate = document.createElement('input');
  expiryDate.className = 'input';
  expiryDate.type = 'date';
  if (existing?.expiresAt) expiryDate.value = new Date(existing.expiresAt).toISOString().slice(0, 10);
  const expiryField = field('Expiry date', expiryDate, 'The key stops working after this day.');

  // --- Models -------------------------------------------------------------
  // Free models are preselected: a new key is useful immediately, and the
  // operator opts in to the billed ones deliberately. The quick actions are
  // the only way to widen or clear the selection.
  const catalog = state.models.length > 0 ? state.models : [];
  const freeIds = catalog.filter((model) => !model.premier).map((model) => model.id);

  let unrestricted = existing !== undefined && existing.modelsRestricted !== true;
  const selected = new Set(
    existing === undefined
      ? freeIds
      : (existing.modelsRestricted === true ? (existing.allowedModels ?? []) : []),
  );

  const modelList = document.createElement('div');
  modelList.className = 'pill-list';
  const pills = new Map();
  for (const model of catalog) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'pill';
    pill.textContent = model.displayName ?? model.id;
    pill.title = model.premier ? 'Premium — billed in Theos' : 'Free — unmetered';
    pill.dataset.on = String(selected.has(model.id));
    pill.addEventListener('click', () => {
      // Touching any pill means an explicit list, not "every model".
      unrestricted = false;
      if (selected.has(model.id)) selected.delete(model.id);
      else selected.add(model.id);
      pill.dataset.on = String(selected.has(model.id));
    });
    pills.set(model.id, pill);
    modelList.appendChild(pill);
  }
  if (catalog.length === 0) {
    const hint = document.createElement('span');
    hint.className = 'tiny muted';
    hint.textContent = 'Model list unavailable.';
    modelList.appendChild(hint);
  }

  const modelsField = field(
    'Allowed models',
    modelList,
    'Free models are preselected. Use All models for an unrestricted key; an empty selection allows nothing.',
  );

  const quickPicks = document.createElement('div');
  quickPicks.className = 'row';
  quickPicks.style.gap = '6px';
  const freeButton = document.createElement('button');
  freeButton.type = 'button';
  freeButton.className = 'btn btn--secondary btn--sm';
  freeButton.textContent = 'Select free';
  const allButton = document.createElement('button');
  allButton.type = 'button';
  allButton.className = 'btn btn--secondary btn--sm';
  allButton.textContent = 'All models';
  allButton.title = 'Unrestricted: allows every model, including future ones';
  const noneButton = document.createElement('button');
  noneButton.type = 'button';
  noneButton.className = 'btn btn--secondary btn--sm';
  noneButton.textContent = 'Clear';
  quickPicks.append(freeButton, allButton, noneButton);

  const setSelection = (ids) => {
    selected.clear();
    for (const id of ids) selected.add(id);
    for (const [id, pill] of pills) pill.dataset.on = String(selected.has(id));
  };
  freeButton.addEventListener('click', () => { unrestricted = false; setSelection(freeIds); });
  noneButton.addEventListener('click', () => { unrestricted = false; setSelection([]); });
  // "All models" is the unrestricted key: it keeps working when DeepAI adds a
  // model, which is what the old checkbox expressed.
  allButton.addEventListener('click', () => {
    unrestricted = true;
    setSelection(catalog.map((model) => model.id));
  });

  // --- Conditional visibility --------------------------------------------
  // Fields that cannot apply are removed from the form rather than disabled,
  // so the dialog only shows decisions that actually matter.
  const syncVisibility = () => {
    const limited = window_.value !== 'unlimited';
    tokensField.hidden = !limited;
    requestsField.hidden = !limited;
    expiryField.hidden = expiryMode.value !== 'date';
  };
  window_.addEventListener('change', syncVisibility);
  expiryMode.addEventListener('change', syncVisibility);
  syncVisibility();

  const error = document.createElement('div');
  error.className = 'note note--error';
  error.hidden = true;

  const submit = document.createElement('button');
  submit.className = 'btn btn--primary';
  submit.textContent = existing ? 'Save changes' : 'Create key';
  const cancel = document.createElement('button');
  cancel.className = 'btn btn--secondary';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', closeModal);

  const actions = document.createElement('div');
  actions.className = 'row';
  actions.style.justifyContent = 'flex-end';
  actions.append(cancel, submit);

  form.append(
    field('Name', name, 'Shown in the dashboard and in usage rows.'),
    field('Limit window', window_, 'Unlimited applies no token or request cap.'),
    tokensField,
    requestsField,
    field('Expires', expiryMode),
    expiryField,
    quickPicks,
    modelsField,
    error,
    actions,
  );

  openModal(existing ? 'Edit API key' : 'Create API key', form);

  submit.addEventListener('click', async () => {
    error.hidden = true;
    const limited = window_.value !== 'unlimited';
    const body = {
      name: name.value.trim(),
      limitWindow: window_.value,
      limitTokens: !limited || limitTokens.value === '' ? null : Number(limitTokens.value),
      limitRequests: !limited || limitRequests.value === '' ? null : Number(limitRequests.value),
      expiresAt: expiryMode.value === 'never'
        ? null
        : (expiryDate.value === '' ? null : new Date(`${expiryDate.value}T23:59:59`).getTime()),
      // "All models" means unrestricted (future models included); anything
      // else is an explicit list, and an empty list allows nothing.
      modelsRestricted: !unrestricted,
      allowedModels: unrestricted ? [] : [...selected],
    };
    if (body.name === '') {
      error.textContent = 'A name is required.';
      error.hidden = false;
      return;
    }
    submit.disabled = true;
    try {
      if (existing) {
        await api(`/keys/${existing.id}`, { method: 'PATCH', body });
        closeModal();
        toast('Key updated');
        onDone();
      } else {
        const created = await api('/keys', { method: 'POST', body });
        showCreatedKey(created.plaintext, created.key.name, onDone);
      }
    } catch (caught) {
      error.textContent = String(caught.message ?? caught);
      error.hidden = false;
      submit.disabled = false;
    }
  });
}

/** One-time reveal of a freshly created key. */
function showCreatedKey(plaintext, name, onDone) {
  const wrap = document.createElement('div');
  wrap.className = 'stack';

  const note = document.createElement('div');
  note.className = 'note note--warning';
  note.textContent = 'Copy this key now. It is stored only as a hash and cannot be shown again.';

  const done = document.createElement('button');
  done.className = 'btn btn--primary';
  done.textContent = 'Done';
  done.addEventListener('click', () => {
    closeModal();
    toast(`Key "${name}" created`);
    onDone();
  });

  const actions = document.createElement('div');
  actions.className = 'row';
  actions.style.justifyContent = 'flex-end';
  actions.appendChild(done);

  wrap.append(note, snippet(plaintext), actions);
  openModal(`Key "${name}" created`, wrap);
}

/* ------------------------------------------------------------------ router */

function currentRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  return hash === '' ? 'home' : hash.split('/')[0];
}

/**
 * Repaint for the current route.
 *
 * The account is re-read on every navigation: it is user-initiated, cheap, and
 * keeps the top-bar control honest when the session changed elsewhere (another
 * tab, an expired key, a `/logout` typed into the address bar).
 */
async function render({ refreshAccount = true } = {}) {
  if (refreshAccount) await loadAccount();
  const route = currentRoute();
  for (const link of document.querySelectorAll('.nav__link')) {
    link.classList.toggle('is-active', link.dataset.route === route);
  }
  const handler = routes[route] ?? renderHome;
  try {
    await handler();
  } catch (error) {
    view.innerHTML = `<div class="note note--error">${esc(error.message ?? error)}</div>`;
  }
}

window.addEventListener('hashchange', () => { void render(); });

// A page restored from the back/forward cache can carry a stale account state.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) void render();
});

// Returning to the tab is a good moment to re-check the session.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void loadAccount();
});

/* Kick off: account + catalog in parallel, then the first view. */
(async () => {
  await Promise.all([loadAccount(), loadModels().catch(() => [])]);
  // DeepAI's callback redirects here with ?logged-in=1; confirm it once.
  if (new URLSearchParams(location.search).has('logged-in')) {
    if (state.account?.signedIn === true) toast('Logged in to DeepAI');
    history.replaceState(null, '', `${location.pathname}${location.hash}`);
  }
  await render({ refreshAccount: false });
  // Keep the balance reasonably fresh while the tab is open.
  setInterval(() => { void loadAccount(); }, 60_000);
})();
