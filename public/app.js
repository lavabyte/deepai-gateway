/* ==========================================================================
   DeepAI Gateway — dashboard client
   No framework: small render helpers plus a hash router.
   ========================================================================== */

const $ = (id) => document.getElementById(id);
const view = $('view');

/* ------------------------------------------------------------------- utils */

/*
 * Formatted in the active language rather than in `en-US`: a German reader expects
 * 1.234,5 and a Polish one 1 234,5, and both are decided by the locale.
 */
const numberFormat = () => new Intl.NumberFormat(state.locale);

/** Compact token counts: 1234567 → 1.23M */
function tokens(value) {
  const n = Number(value) || 0;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Exact count with separators. */
function exact(value) {
  return numberFormat().format(Number(value) || 0);
}

/**
 * Relative time: "just now", "4m ago", "3d ago".
 *
 * The unit letters are translated and the number is formatted in the active language, so
 * the whole phrase reads naturally rather than as an English skeleton with a number in it.
 */
function ago(ms) {
  if (!ms) return '—';
  const delta = Date.now() - Number(ms);
  const n = (value) => numberFormat().format(value);
  if (delta < 45_000) return t('time.justNow');
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return t('time.minutesAgo', { count: n(minutes) });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hoursAgo', { count: n(hours) });
  const days = Math.floor(hours / 24);
  if (days < 30) return t('time.daysAgo', { count: n(days) });
  return new Date(Number(ms)).toLocaleDateString(state.locale);
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
    throw new ApiError(t('error.unexpectedAnswer', { status: response.status }), response.status);
  }
  if (!response.ok || json.ok === false) {
    throw new ApiError(json.error ?? t('error.http', { status: response.status }), response.status);
  }
  return json;
}

/** Whether a failure means "the session ended". */
function isAuthFailure(error) {
  return error instanceof ApiError && error.status === 401;
}


/**
 * The one way in: the account JSON, read out of DeepAI's own API page.
 *
 * DeepAI's own browser sign-in always calls back to `127.0.0.1`, which nothing here can
 * change, and a Google or Apple account has no password to post anywhere. But the account
 * JSON is served to the visitor's own browser, and a browser shows it as a plain page — so
 * they open that address, where they are already signed in, and copy what it says.
 *
 * Two earlier versions of this instruction were worse, and both were taught by trying
 * them: a browser-console command returns `'OK'` unless the console happens to be on
 * DeepAI's own origin, because the API answers `201 OK` to an unauthenticated request;
 * and a link the visitor had to click to reveal these steps meant the instructions they
 * needed were the ones they could not see.
 */
function profilePasteHelp(prefix = '') {
  return `
    <section class="step" id="${prefix}profile-step">
      <!--
        The list is split so the hint sits between the two steps it concerns. The second
        list restarts at 2, so the numbering stays honest while a paragraph separates
        them visually.
      -->
      <ol class="step__list">
        <li>
          ${t('signin.step1')} <a href="https://deepai.org" target="_blank" rel="noreferrer noopener">https://deepai.org</a>
          ${t('signin.step1Tail')}
        </li>
      </ol>

      <div class="note note--info mt-3">
        ${t('signin.okHint')}
      </div>

      <ol class="step__list mt-3" start="2">
        <li>
          ${t('signin.step2')}
          <a href="https://api.deepai.org/daily-time-sync/user/" target="_blank" rel="noreferrer noopener">https://api.deepai.org/daily-time-sync/user/</a>${t('signin.step2Tail')}
        </li>
        <li>${t('signin.step3')} <strong>Content</strong> ${t('signin.step3Tail')}</li>
      </ol>

      <div class="field mt-3">
        <label class="field__label" for="${prefix}profile-paste">Content</label>
        <textarea class="textarea" id="${prefix}profile-paste" rows="7" spellcheck="false" autocomplete="off"
          placeholder='{"pk": …, "username": "…", "email": "…", "userprofile": {"api_key": "…"}}'></textarea>
        <div class="field__hint">
          ${t('signin.contentHint')}
        </div>
      </div>
      <div class="row mt-3"><button class="btn btn--primary" id="${prefix}login-with-profile" type="button">${t('common.logIn')}</button></div>
    </section>`;
}

/**
 * Sign in with the account details the visitor pasted.
 *
 * Both secrets are cleared from the field once accepted, so nothing lingers in the page.
 */
async function signInWithProfile() {
  const field = $('profile-paste');
  const text = field?.value?.trim() ?? '';
  if (text === '') {
    toast(t('signin.runCommand'), 'error');
    field?.focus();
    return;
  }

  const button = $('login-with-profile');
  const label = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = t('signin.signingIn');
  }
  try {
    await api('/login/profile', { method: 'POST', body: { text } });
    if (field) field.value = '';
    toast(t('signin.loggedIn'));
    await loadAccount();
    await render();
  } catch (error) {
    toast(String(error.message ?? error), 'error');
    if (button) {
      button.disabled = false;
      button.textContent = label ?? t('common.logIn');
    }
    field?.focus();
    field?.select();
  }
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
/**
 * The way in.
 *
 * One route only: the account JSON, copied from DeepAI's own API page. The password
 * form and the bare-key form were both removed — the password route cannot work for a
 * Google or Apple account, and a bare key cannot supply the email, so keeping three
 * doors meant two of them were the wrong one for most visitors.
 *
 * @param {string} prefix - distinguishes the ids when both cards are in the DOM.
 * @returns {string} markup containing the pasted-JSON form.
 */
function signInRoutes(prefix = '') {
  return `<div class="mt-3">${profilePasteHelp(prefix)}</div>`;
}

/**
 * Wire every sign-in control a card may contain.
 *
 * All of them are optional, because a card can show any subset — but the two cards
 * that can show them must not each carry their own copy of this. They did, and the
 * overview's copy kept the old button while the log-in screen got the new form, so
 * one of them silently served a screen that no longer existed anywhere else.
 */
function wireSignInForms(prefix = '') {
  const id = (name) => $(`${prefix}${name}`);
  id('login-with-profile')?.addEventListener('click', () => void signInWithProfile(prefix));
}

/**
 * Render a view that needs a session, or a log-in prompt when there is none.
 *
 * @returns {boolean} true when the caller should stop rendering.
 */
function needsLogin() {
  if (state.account?.signedIn === true) return false;
  view.innerHTML = `
    <div class="page__head">
      <h1 class="page__title">${t('signin.title')}</h1>
      <p class="page__sub">${t('signin.subtitle')}</p>
    </div>
    <div class="card">
      <div class="card__title">${t('signin.notLoggedIn')}</div>
      <div class="card__sub mt-2">${t('signin.lead')}</div>
      ${signInRoutes()}
    </div>`;

  wireSignInForms();
  return true;
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

/**
 * Ask for confirmation in the app, not in a browser dialog.
 *
 * `window.confirm` blocks the whole page, cannot be styled, is rendered by the browser
 * rather than as part of this interface, and on some platforms can be suppressed
 * entirely — so a destructive action would either look foreign or lose its guard. This
 * reuses the modal the key editor already opens, which means Escape, the backdrop and
 * the focus handling all behave the same way.
 *
 * @param {object} options
 * @param {string} options.title - the action being confirmed, as a heading.
 * @param {string[]} options.lines - the consequences, one paragraph each.
 * @param {string} [options.confirmLabel] - what the button says; it should name the act.
 * @param {boolean} [options.danger] - style the button as destructive.
 * @returns {Promise<boolean>} whether the visitor confirmed.
 */
function confirmAction({ title, lines, confirmLabel = t('common.confirm'), danger = false }) {
  return new Promise((resolve) => {
    const body = document.createElement('div');
    body.className = 'stack';

    for (const line of lines) {
      const paragraph = document.createElement('p');
      paragraph.className = 'card__sub';
      paragraph.textContent = line;
      body.append(paragraph);
    }

    const actions = document.createElement('div');
    actions.className = 'row row--right mt-3';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn--ghost';
    cancel.textContent = t('common.cancel');

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = danger ? 'btn btn--danger' : 'btn btn--primary';
    confirm.textContent = confirmLabel;

    actions.append(cancel, confirm);
    body.append(actions);

    let answered = false;
    const settle = (value) => {
      if (answered) return;
      answered = true;
      resolve(value);
    };

    cancel.addEventListener('click', () => {
      settle(false);
      closeModal();
    });
    // The destructive control is never the default: Escape, the backdrop and the close
    // button all mean "no", and only the named button means "yes".
    confirm.addEventListener('click', () => {
      settle(true);
      closeModal();
    });

    openModal(title, body, () => settle(false));
    // Cancel takes the caret, so a stray Enter does not perform the destructive action.
    cancel.focus();
  });
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

/**
 * Copy text to the clipboard, and say so.
 *
 * `navigator.clipboard` exists only in a **secure context** — HTTPS, or localhost. A
 * gateway reached at `http://some-host:port` has no `navigator.clipboard` at all, so the
 * modern call throws and nothing is copied; that is a plain `http://` deployment, not an
 * exotic one. The fallback below is the pre-Clipboard-API technique, which works in an
 * insecure context because it drives the browser's own copy command on a selected field.
 *
 * If even that fails, the text is selected so the visitor can press Ctrl/Cmd+C themselves
 * — a failed copy must not leave them with a key they cannot take away.
 *
 * @param {string} text
 * @param {HTMLElement} [button] - gets brief "Copied" feedback when given.
 * @param {HTMLElement} [field] - the element holding the text, selected as a last resort.
 */
async function copy(text, button, field) {
  const feedback = () => {
    if (button) {
      const original = button.textContent;
      button.textContent = t('common.copied');
      setTimeout(() => { button.textContent = original; }, 1400);
    } else {
      toast(t('common.copiedToClipboard'));
    }
  };

  // 1. The Clipboard API, when the context allows it.
  if (navigator.clipboard?.writeText !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      feedback();
      return;
    } catch {
      /* fall through: a denied permission is not a reason to give up */
    }
  }

  // 2. The legacy command, which works without a secure context.
  try {
    const scratch = document.createElement('textarea');
    scratch.value = text;
    // Off-screen rather than hidden: a `display: none` field cannot be selected.
    scratch.setAttribute('readonly', '');
    scratch.style.position = 'fixed';
    scratch.style.top = '-1000px';
    scratch.style.opacity = '0';
    document.body.appendChild(scratch);
    scratch.select();
    const ok = document.execCommand('copy');
    scratch.remove();
    if (ok) {
      feedback();
      return;
    }
  } catch {
    /* fall through to selecting it for the visitor */
  }

  // 3. Leave it selected and say what to press.
  if (field) {
    const range = document.createRange();
    range.selectNodeContents(field);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
  toast(t('common.pressToCopy'), 'error');
}

/** A code snippet with a copy affordance. */
function snippet(text) {
  const wrap = document.createElement('div');
  wrap.className = 'snippet';
  const code = document.createElement('code');
  code.textContent = text;
  const button = document.createElement('button');
  button.className = 'snippet__copy';
  button.textContent = t('common.copy');
  button.addEventListener('click', () => copy(text, button, code));
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

$('auth-button').addEventListener('click', () => { void onAuthButton(); });

$('locale-button').addEventListener('click', (event) => {
  // The click must not reach the document handler that closes the menu.
  event.stopPropagation();
  toggleLocaleMenu();
});
document.addEventListener('click', (event) => {
  if ($('locale-menu')?.hidden === false && !event.target.closest?.('.lang')) closeLocaleMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && $('locale-menu')?.hidden === false) closeLocaleMenu();
});
$('theme-toggle').addEventListener('click', () => {
  applyTheme(effectiveTheme() === 'dark' ? 'light' : 'dark');
});


/* ------------------------------------------------------------- shared state */

const state = {
  account: undefined,
  models: [],
  // The active language and its loaded strings. See the i18n section below.
  locale: 'en',
  strings: {},
};

/* --------------------------------------------------------------------- i18n */

/**
 * The languages the dashboard speaks.
 *
 * The flag is what the switcher shows, so it has to be a single emoji rather than an
 * image: it renders at any size, needs no asset, and cannot be missing while a request
 * is in flight. `label` is the language's own name, which is what a speaker looks for.
 */
const LOCALES = [
  { code: 'en', flag: '🇬🇧', label: 'English' },
  { code: 'pl', flag: '🇵🇱', label: 'Polski' },
  { code: 'de', flag: '🇩🇪', label: 'Deutsch' },
  { code: 'es', flag: '🇪🇸', label: 'Español' },
];

const LOCALE_KEY = 'deepai-gateway-locale';

/** The locale entry for a code, or English when the code is unknown. */
function localeOf(code) {
  return LOCALES.find((entry) => entry.code === code) ?? LOCALES[0];
}

/**
 * Which language to start in.
 *
 * An explicit choice wins; otherwise the browser's own preference decides, so a Polish
 * visitor gets Polish without touching anything. `navigator.languages` is checked in
 * order, and only the primary subtag matters (`de-AT` is German).
 *
 * @returns {string} a code from {@link LOCALES}.
 */
function detectLocale() {
  const stored = localStorage.getItem(LOCALE_KEY);
  if (typeof stored === 'string' && LOCALES.some((entry) => entry.code === stored)) return stored;

  const candidates = Array.isArray(navigator.languages) && navigator.languages.length > 0
    ? navigator.languages
    : [navigator.language];
  for (const candidate of candidates) {
    const primary = String(candidate ?? '').toLowerCase().split('-')[0];
    if (LOCALES.some((entry) => entry.code === primary)) return primary;
  }
  return 'en';
}

/**
 * Load one language's strings.
 *
 * They live as JSON next to the dashboard rather than inside this file, so a translation
 * is a data change and never a code change. A language that fails to load leaves the
 * previous strings in place instead of blanking the interface.
 *
 * @param {string} code
 * @returns {Promise<boolean>} whether the strings were loaded.
 */
async function loadLocale(code) {
  const entry = localeOf(code);
  try {
    const response = await fetch(`/locales/${entry.code}.json`, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const strings = await response.json();
    if (strings === null || typeof strings !== 'object') throw new Error('not an object');
    state.locale = entry.code;
    state.strings = strings;
    return true;
  } catch (error) {
    // English is the one language that must always work: it is the fallback every other
    // language falls back to, so a broken file cannot be allowed to empty the dashboard.
    if (entry.code !== 'en') {
      toast(t('error.locale', { name: entry.label, message: error?.message ?? error }), 'error');
      if (state.locale !== 'en') await loadLocale('en');
    }
    return false;
  }
}

/**
 * One translated string.
 *
 * `params` fills `{name}` placeholders, which is how a sentence keeps its own word order
 * in every language instead of being assembled from fragments.
 *
 * @param {string} key
 * @param {Record<string, string|number>} [params]
 * @returns {string} the translation, the key itself when it is missing, so a gap is
 *   visible rather than silently blank.
 */
/**
 * One counted phrase.
 *
 * A phrase whose wording depends on the number needs both the number — so the language's
 * plural rule can pick a form — and the formatted text, so the digits read the way that
 * language writes them. Passing them together keeps every call site to one line.
 *
 * @param {string} key
 * @param {number} value
 * @returns {string}
 */
function counted(key, value) {
  return t(key, { count: value, formatted: exact(value) });
}

/** Fill `{name}` placeholders from `params`. */
function fill(value, params) {
  if (params === undefined) return value;
  return value.replace(/\{(\w+)\}/g, (match, name) => (
    params[name] === undefined ? match : String(params[name])
  ));
}

function t(key, params) {
  const value = state.strings[key];
  if (typeof value === 'string') return fill(value, params);

  /*
   * A plural entry is an object of forms — `{ one, few, many, other }` — chosen by the
   * language's own rules rather than by a count comparison, because the rules differ:
   * Polish has a "few" for 2–4 that English does not, and it also needs "many" for 5+.
   * `Intl.PluralRules` is the browser's own implementation of exactly that.
   *
   * A language may supply only the forms it needs; `other` is the fallback, and English
   * is guaranteed to have it.
   */
  if (value !== null && typeof value === 'object') {
    const count = Number(params?.count);
    if (!Number.isFinite(count)) return key;
    const form = new Intl.PluralRules(state.locale).select(count);
    const chosen = value[form] ?? value.other;
    return typeof chosen === 'string' ? fill(chosen, params) : key;
  }
  return key;
}

/** Re-apply translations to the static shell. */
function applyStaticText() {
  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of document.querySelectorAll('[data-i18n-attr]')) {
    // `data-i18n-attr="title:key,aria-label:key2"` — attributes a translator must reach.
    for (const pair of node.dataset.i18nAttr.split(',')) {
      const [attribute, key] = pair.split(':').map((part) => part.trim());
      if (attribute !== '' && key !== undefined) node.setAttribute(attribute, t(key));
    }
  }
  document.documentElement.lang = state.locale;
}

/**
 * Fill the language menu with every language, as flags.
 *
 * Built once and toggled, rather than rebuilt on each open: the entries never change, and
 * a menu that is re-created on every click loses the focus ring mid-interaction.
 */
function renderLocaleMenu() {
  const menu = $('locale-menu');
  if (menu === null) return;
  menu.replaceChildren(...LOCALES.map((entry) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'lang__option';
    option.dataset.locale = entry.code;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(entry.code === state.locale));
    // Built as nodes rather than as HTML: the label is a language's own name, and text
    // assembled this way cannot be mistaken for markup.
    const flag = document.createElement('span');
    flag.className = 'lang__flag';
    flag.setAttribute('aria-hidden', 'true');
    flag.textContent = entry.flag;
    const label = document.createElement('span');
    label.className = 'lang__name';
    label.textContent = entry.label;
    option.append(flag, label);
    option.addEventListener('click', () => {
      closeLocaleMenu();
      void setLocale(entry.code);
    });
    return option;
  }));
}

/** Open or close the language menu. */
function closeLocaleMenu() {
  const menu = $('locale-menu');
  if (menu === null) return;
  menu.hidden = true;
  $('locale-button')?.setAttribute('aria-expanded', 'false');
}

function toggleLocaleMenu() {
  const menu = $('locale-menu');
  if (menu === null) return;
  const opening = menu.hidden;
  if (opening) {
    renderLocaleMenu();
    menu.hidden = false;
    $('locale-button')?.setAttribute('aria-expanded', 'true');
    menu.querySelector('[data-locale]')?.focus();
  } else {
    closeLocaleMenu();
  }
}

/** The flag and name the switcher shows for the active language. */
function renderLocaleButton() {
  const entry = localeOf(state.locale);
  const flag = $('locale-flag');
  if (flag !== null) flag.textContent = entry.flag;
  const button = $('locale-button');
  if (button !== null) button.setAttribute('title', entry.label);
  for (const option of document.querySelectorAll('[data-locale]')) {
    option.classList.toggle('is-active', option.dataset.locale === state.locale);
  }
}

/**
 * Switch language.
 *
 * The whole view is re-rendered rather than patched: every string in it came from `t()`,
 * so a re-render is the one operation that cannot leave a half-translated screen behind.
 *
 * @param {string} code
 */
async function setLocale(code) {
  const entry = localeOf(code);
  if (entry.code === state.locale && Object.keys(state.strings).length > 0) return;
  if (!await loadLocale(entry.code)) return;
  localStorage.setItem(LOCALE_KEY, entry.code);
  applyStaticText();
  renderLocaleButton();
  renderAccountBadge();
  await render({ refreshAccount: false });
}

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

 */
function renderAccountBadge() {
  const badge = $('account-badge');
  const text = $('account-badge-text');
  const button = $('auth-button');
  const account = state.account;

  if (account === undefined) {
    badge.className = 'badge badge--gray';
    text.textContent = t('common.checking');
    button.hidden = true;
    return;
  }

  /*
   * The control appears only when it has something to do. Signed out there is nothing:
   * the overview *is* the sign-in form, so a "Log in" button beside it was a second door
   * to the same room. Signed in it is the way out, and it stays in the top bar where the
   * visitor last saw it.
   */
  button.hidden = !account.signedIn;
  if (account.signedIn) {
    badge.className = account.balanceLow ? 'badge badge--amber' : 'badge badge--green';
    const balance = account.allowance?.balance;
    text.textContent = balance
      ? `${accountName(account)} · ${balance} Credits`
      : accountName(account);
  } else {
    badge.className = 'badge badge--red';
    text.textContent = t('common.loggedOut');
  }
}

/** The top-bar action: log out. */
async function onAuthButton() {
  if (state.account?.signedIn === true) await logOutEverywhere();
}

/** Log out and repaint the current view. */
async function logOutEverywhere() {
  try {
    await api('/logout', { method: 'POST' });
    toast(t('common.loggedOut'));
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
    <div class="spark" title="${t('home.sparkTitle')}">
      ${daily.map((day) => {
        const height = Math.max(2, Math.round((day.tokens / max) * 44));
        const isPeak = day === peak && peak.tokens > 0;
        return `<div class="spark__bar" data-peak="${isPeak}" style="height:${height}px"
          title="${esc(day.label)} · ${counted('home.sparkTokens', day.tokens)} · ${counted('home.sparkRequests', day.requests)}"></div>`;
      }).join('')}
    </div>`;
}

/** Usage table for a per-model breakdown; hides models without usage. */
function modelUsageRows(models, emptyText) {
  const used = models.filter((model) => model.requests > 0 && model.totalTokens > 0);
  if (used.length === 0) {
    return `<tr><td colspan="4"><div class="empty"><div class="empty__title">${t('home.noUsage')}</div>${esc(emptyText)}</div></td></tr>`;
  }
  const max = Math.max(...used.map((model) => model.totalTokens));
  return used.map((model) => `
    <tr>
      <td>
        <div class="model-row__name truncate">${esc(model.model)}</div>
        <div class="tiny muted">${esc(t('models.lastUsed', { when: ago(model.lastUsedAt) }))}</div>
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
    return `<tr><td colspan="${showKey ? 7 : 6}"><div class="empty"><div class="empty__title">${t('home.noRequests')}</div>${t('home.sendRequest')} <code>/v1/chat/completions</code> ${t('home.sendRequestTail')}</div></td></tr>`;
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
            ? `<span class="badge badge--violet" title="${t('common.billedInCredits')}">${t('common.premium')}</span>`
            : premium === false
              ? `<span class="badge badge--gray" title="${t('common.unmetered')}">${t('common.free')}</span>`
              : ''}
        </span>
      </td>
      ${showKey ? `<td class="truncate tiny" style="max-width:130px">${esc(item.keyName || '—')}</td>` : ''}
      <td class="num">${item.totalTokens > 0 ? exact(item.totalTokens) : '—'}</td>
      <td class="num tiny muted">${item.inputTokens}/${item.outputTokens}${item.reasoningTokens > 0 ? `<span title="${t('home.reasoningTokens')}"> · r${tokens(item.reasoningTokens)}</span>` : ''}</td>
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
            <div class="card__title">${t('account.title')}</div>
            <div class="card__sub">${t('account.subtitle')}</div>
          </div>
          <span class="badge badge--red"><span class="dot"></span>${t('account.notSignedIn')}</span>
        </div>
        <div class="mt-3 stack">
          <div class="note">${t('account.lead')}</div>
          ${signInRoutes('account-')}
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
          <div class="card__title">${t('account.title')}</div>
          <div class="card__sub">${t('account.loggedInAs', { name: accountName(account) })}${account.isPro ? t('account.pro') : ''}</div>
        </div>
        <span class="badge ${account.balanceLow ? 'badge--amber' : 'badge--green'}"><span class="dot"></span>${account.balanceLow ? t('account.lowBalance') : t('account.active')}</span>
      </div>
      ${allowance && allowance.balance !== null ? `
        <div class="mt-3">
          <div class="row row--between tiny muted">
            <span>${t('account.credits')}</span>
            <span class="mono">${esc(allowance.balance)} / ${esc(allowance.granted ?? '—')}</span>
          </div>
          ${pct !== undefined ? `<div class="bar mt-2"><div class="bar__fill ${account.balanceLow ? 'bar__fill--warn' : ''}" style="width:${pct}%"></div></div>` : ''}
          <div class="tiny muted mt-2">${t('account.resets', { when: allowance.refreshAt ? when(Date.parse(allowance.refreshAt)) : '—' })}</div>
        </div>` : ''}
      <div class="row mt-3 row--wrap">
        <button class="btn btn--secondary btn--sm" id="refresh-allowance">${t('account.refresh')}</button>
        <button class="btn btn--ghost btn--sm" id="forget-account">${t('account.forget')}</button>
        <span class="spacer"></span>
        <span class="tiny muted">${esc(keyQuotaLabel(account.keyQuota))}</span>
      </div>
      <div class="tiny muted mt-2">
        ${t('account.sessionNote', { when: account.sessionExpiresAt ? when(account.sessionExpiresAt) : t('common.never') })}
      </div>
      <div class="tiny muted mt-2" id="auth-events"></div>
    </div>`;
}

/** One-line summary of the key quota. */
function keyQuotaLabel(quota) {
  if (quota === undefined || quota === null) return '';
  return t('account.keysUsed', { used: exact(quota.used), max: exact(quota.max) });
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
    target.innerHTML = esc(t('account.lastActivity', {
      // The server names its own events; each is labelled here so the trail reads in the
      // visitor's language rather than in the vocabulary of the database.
      events: events.map((event) => `${t(`authEvent.${event.event}`)} ${ago(event.createdAt)}`).join(' · '),
    }));
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
        <td class="num">${entry.priced ? esc(usd(entry.usd)) : `<span class="muted" title="${t('pricing.noEquivalent')}">n/a</span>`}</td>
      </tr>`)
    .join('');

  return `
    <div class="card">
      <div class="row row--between">
        <div>
          <div class="card__title">${t('home.moneySaved')}</div>
          <div class="card__sub">${t('home.moneySavedSub')}</div>
        </div>
        <div class="row" style="gap:8px">
          <span class="badge ${live ? 'badge--green' : 'badge--amber'}"
                title="${esc(live ? t('pricing.live') : t('pricing.bundled', { source: pricing.source ?? 'bundled' }))}">
            <span class="dot"></span>${live ? t('pricing.liveRates') : t('pricing.cachedRates')}
          </span>
          <span class="badge badge--gray">${esc(t('home.monthThisMonth', { amount: usd(month.usd) }))}</span>
        </div>
      </div>

      <div class="grid grid--3 mt-3">
        <div>
          <div class="eyebrow">${t('metric.today')}</div>
          <div class="metric__value" style="font-size:22px">${esc(usd(today.usd))}</div>
        </div>
        <div>
          <div class="eyebrow">${t('metric.thisMonth')}</div>
          <div class="metric__value" style="font-size:22px">${esc(usd(month.usd))}</div>
        </div>
        <div>
          <div class="eyebrow">${t('metric.allTime')}</div>
          <div class="metric__value" style="font-size:22px">${esc(usd(all.usd))}</div>
        </div>
      </div>

      ${rows === '' ? '' : `
        <div class="table-wrap mt-3">
          <table class="table">
            <thead><tr><th>${t('metric.model')}</th><th class="num">${t('metric.tokens')}</th><th class="num">${t('metric.equivalent')}</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`}

      <div class="row row--between mt-3">
        <p class="tiny muted" style="margin:0;max-width:70ch">
          ${esc(t('pricing.pricedAgainst', { when: asOf }))}
          ${unpriced.length > 0 ? esc(t('pricing.notPriced', { models: unpriced.join(', ') })) : ''}
          ${esc(t('pricing.cacheNote'))}
        </p>
        <button class="btn btn--secondary btn--sm" id="refresh-pricing">${t('pricing.refresh')}</button>
      </div>
    </div>`;
}

/** Wire the account card buttons. */
function wireAccountCard(rerender) {
  // The same sign-in controls as the log-in screen, so the two cannot drift apart.
  wireSignInForms(rerender);

  $('refresh-allowance')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = t('pricing.refreshing');
    try {
      const result = await api('/account/refresh', { method: 'POST' });
      if (result.ok) toast(t('account.balanceToast', { amount: result.allowance.balance }));
      else toast(result.error ?? t('error.refresh'), 'error');
    } catch (error) {
      toast(String(error.message ?? error), 'error');
    }
    await loadAccount();
    rerender();
  });

  // Removing the account is destructive, so it gets its own confirm step.
  $('forget-account')?.addEventListener('click', async () => {
    const username = accountName(state.account);
    const confirmed = await confirmAction({
      title: t('account.removeTitle'),
      lines: [
        t('account.removeLine1', { name: username }),
        t('account.removeLine2'),
        t('account.removeLine3'),
      ],
      confirmLabel: t('account.removeConfirm'),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api('/account/forget', { method: 'POST' });
      toast(t('account.removed'));
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
  view.innerHTML = `<div class="loading"><span class="spinner"></span>${t('home.loading')}</div>`;

  let data;
  try {
    data = await api('/usage/summary');
  } catch (error) {
    if (isAuthFailure(error)) {
      await loadAccount();
      if (needsLogin()) return;
    }
    view.innerHTML = `<div class="note note--error">${esc(t('error.usage', { message: error.message }))}</div>`;
    return;
  }
  const recent = await api('/usage/recent?limit=20').catch(() => ({ requests: [] }));

  const { today, month, all } = data;
  const modelsUsedMonth = data.modelsMonth.filter((model) => model.totalTokens > 0);

  view.innerHTML = `
    <div class="page__head">
      <h1 class="page__title">${t('home.title')}</h1>
      <p class="page__sub">${t('home.subtitle')}</p>
    </div>

    <div class="stack">
      <div class="grid grid--4">
        ${metricCard({
          eyebrow: t('metric.tokensThisMonth'),
          value: tokens(month.totalTokens),
          label: t('metric.tokensThisMonthFoot'),
          foot: `${counted('metric.requestsCount', month.requests)} · ${counted('metric.failedCount', month.failedRequests)}`,
        })}
        ${metricCard({
          eyebrow: t('metric.tokensToday'),
          value: tokens(today.totalTokens),
          label: t('metric.tokensTodayFoot'),
          foot: `${counted('metric.requestsCount', today.requests)} · ${counted('metric.failedCount', today.failedRequests)}`,
        })}
        ${metricCard({
          eyebrow: t('metric.allTime'),
          value: tokens(all.totalTokens),
          label: t('metric.allTimeFoot'),
          foot: `${counted('metric.requestsCount', all.requests)} · ${t('metric.averageDuration', { duration: duration(all.avgDurationMs) })}`,
        })}
        ${metricCard({
          eyebrow: t('metric.cacheReads'),
          value: tokens(month.cacheReadTokens),
          label: t('metric.cacheReadsFoot'),
          foot: t('metric.cacheDetail', { reasoning: exact(month.reasoningTokens), writes: exact(month.cacheWriteTokens) }),
        })}
      </div>

      ${savingsCard(data.savings)}

      <div class="grid grid--main">
        <div class="stack">
          <div class="card card--flush">
            <div class="card__head">
              <div>
                <div class="card__title">${t('home.byModel')}</div>
                <div class="card__sub">${t('home.byModelSub')}</div>
              </div>
              <span class="badge badge--gray">${counted('home.modelsActive', modelsUsedMonth.length)}</span>
            </div>
            <div class="table-wrap">
              <table class="table">
                <thead><tr>
                  <th>${t('metric.model')}</th><th class="num">${t('metric.requests')}</th><th class="num">${t('metric.tokens')}</th><th></th>
                </tr></thead>
                <tbody>${modelUsageRows(data.modelsMonth, t('home.modelsEmpty'))}</tbody>
              </table>
            </div>
          </div>

          <div class="card card--flush">
            <div class="card__head">
              <div>
                <div class="card__title">${t('home.recent')}</div>
                <div class="card__sub">${t('home.recentSub')}</div>
              </div>
              <div class="row" style="gap:6px">
                <a class="btn btn--ghost btn--sm" href="/api/usage/export?format=csv" download>${t('home.export')}</a>
                <a class="btn btn--ghost btn--sm" href="#/keys">${t('home.manageKeys')}</a>
              </div>
            </div>
            <div class="table-wrap">
              <table class="table">
                <thead><tr>
                  <th>${t('metric.when')}</th><th>${t('metric.model')}</th><th>${t('metric.key')}</th><th class="num">${t('metric.tokens')}</th>
                  <th class="num hide-sm">${t('metric.inOut')}</th><th class="num hide-sm">${t('metric.time')}</th><th>${t('metric.status')}</th>
                </tr></thead>
                <tbody>${requestRows(recent.requests, true)}</tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="stack">
          ${accountCard()}

          <div class="card">
            <div class="eyebrow">${t('home.last14')}</div>
            <div class="mt-3">${sparkline(data.daily)}</div>
            <div class="row row--between tiny muted mt-2">
              <span>${esc(data.daily[0]?.label ?? '')}</span>
              <span>${esc(data.daily.at(-1)?.label ?? '')}</span>
            </div>
          </div>

          <div class="card">
            <div class="eyebrow">${t('home.useIt')}</div>
            <div class="tiny muted mt-2">${t('home.useItSub')}</div>
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
    button.textContent = t('pricing.refreshing');
    try {
      const result = await api('/pricing/refresh', { method: 'POST' });
      toast(result.ok
        ? t('error.ratesRefreshed', { count: result.matched.length })
        : t('error.ratesFailed', { message: result.error }), result.ok ? 'ok' : 'error');
    } catch (error) {
      toast(String(error.message ?? error), 'error');
    }
    renderHome();
  });
}

/* ------------------------------------------------------------------ models */

async function renderModels() {
  view.innerHTML = `<div class="loading"><span class="spinner"></span>${t('models.loading')}</div>`;
  let payload;
  try {
    payload = await api('/models');
  } catch (error) {
    view.innerHTML = `<div class="note note--error">${esc(t('error.models', { message: error.message }))}</div>`;
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
      <td><span class="badge ${model.premier ? 'badge--violet' : 'badge--green'}">${model.premier ? t('common.premium') : t('common.free')}</span></td>
      <td class="num tiny muted">${esc(tokens(model.contextWindow))}</td>
      <td class="num tiny muted">${esc(tokens(model.maxTokens))}</td>
      <td class="tiny muted">${model.reasoning ? 'none · low · medium · high' : '—'}</td>
      <td class="tiny muted">${model.input.includes('image') ? 'text, image' : 'text'}</td>
      <td class="num tiny muted">${model.premier ? esc(model.rateLabel) : t('common.unmetered')}</td>
      <td class="num tiny">${model.usageMonth ? exact(model.usageMonth.totalTokens) : '<span class="muted">—</span>'}</td>
    </tr>`;

  view.innerHTML = `
    <div class="page__head">
      <h1 class="page__title">${t('models.title')}</h1>
      <p class="page__sub">${t('models.subtitle')}</p>
    </div>

    <div class="stack">
      <div class="grid grid--3">
        ${metricCard({ eyebrow: t('metric.catalog'), value: String(models.length), label: t('metric.modelsAvailable') })}
        ${metricCard({ eyebrow: t('metric.freeTier'), value: String(free.length), label: t('metric.unmeteredModels') })}
        ${metricCard({ eyebrow: t('common.premium'), value: String(premier.length), label: t('common.billedInCredits') })}
      </div>

      <div class="card card--flush">
        <div class="card__head">
          <div>
            <div class="card__title">${t('common.allModels')}</div>
            <div class="card__sub">${t('models.usedNote')}</div>
          </div>
          <button class="btn btn--secondary btn--sm" id="reload-models">${t('models.reload')}</button>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr>
              <th>${t('metric.model')}</th><th>${t('metric.tier')}</th><th class="num">${t('metric.context')}</th><th class="num">${t('metric.maxOut')}</th>
              <th class="hide-sm">${t('metric.reasoning')}</th><th class="hide-sm">${t('metric.input')}</th><th class="num">${t('metric.rate')}</th><th class="num">${t('metric.used')}</th>
            </tr></thead>
            <tbody>${models.map(row).join('')}</tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="eyebrow">${t('models.howBilling')}</div>
        <p class="muted mt-2" style="font-size:13px;max-width:78ch">
          ${t('models.billing')}
        </p>
      </div>
    </div>`;

  $('reload-models').addEventListener('click', async () => {
    await loadModels(true);
    toast(t('models.reloaded'));
    renderModels();
  });
}

/* -------------------------------------------------------------------- keys */

async function renderKeys() {
  if (needsLogin()) return;
  view.innerHTML = `<div class="loading"><span class="spinner"></span>${t('keys.loading')}</div>`;
  let payload;
  try {
    payload = await api('/keys');
  } catch (error) {
    if (isAuthFailure(error)) {
      await loadAccount();
      if (needsLogin()) return;
    }
    view.innerHTML = `<div class="note note--error">${esc(t('error.keys', { message: error.message }))}</div>`;
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
    if (parts.length === 0) return `<span class="tiny muted">${t('common.unlimited')}</span>`;
    const windowLabel = key.limitWindow === 'total'
      ? t('metric.inTotal')
      : t('metric.perWindow', { window: t(`window.${key.limitWindow}`) });
    return `${parts.join('')}<div class="tiny muted mt-2">${windowLabel}</div>`;
  };

  const statusBadge = (status) => {
    const map = {
      active: 'badge--green', limited: 'badge--amber', expired: 'badge--amber', revoked: 'badge--red',
    };
    // The status comes from the server as a stable code; the label is translated here.
    return `<span class="badge ${map[status] ?? 'badge--gray'}"><span class="dot"></span>${esc(t(`status.${status}`))}</span>`;
  };

  const modelCell = (key) => {
    if (key.modelsRestricted !== true) return `<span class="tiny muted">${t('common.allModels')}</span>`;
    if (key.allowedModels.length === 0) return `<span class="badge badge--red">${t('common.none')}</span>`;
    return `<span class="tiny muted">${counted('metric.allowed', key.allowedModels.length)}</span>`;
  };

  const row = (key) => `
    <tr>
      <td>
        <div class="model-row__name">${esc(key.name)}</div>
        <div class="tiny muted mono">${esc(key.prefix)}…</div>
      </td>
      <td class="tiny muted">${esc(key.owner || '—')}</td>
      <td>${statusBadge(key.status)}</td>
      <td class="tiny muted">${key.expiresAt === null ? t('form.expiryNever') : esc(when(key.expiresAt))}</td>
      <td>${modelCell(key)}</td>
      <td style="min-width:170px">${limitCell(key)}</td>
      <td class="tiny muted hide-sm">${esc(ago(key.lastUsedAt))}</td>
      <td>
        <div class="row" style="gap:6px">
          <button class="btn btn--secondary btn--sm" data-action="edit" data-id="${esc(key.id)}">${t('common.edit')}</button>
          <button class="btn btn--danger-ghost btn--sm" data-action="revoke" data-id="${esc(key.id)}">${t('common.revoke')}</button>
        </div>
      </td>
    </tr>`;

  view.innerHTML = `
    <div class="page__head">
      <h1 class="page__title">${t('keys.title')}</h1>
      <p class="page__sub">${t('keys.subtitle')}</p>
    </div>

    <div class="stack">
      <div class="row row--between">
        <span class="eyebrow">${keys.length} of ${quota.max} keys used</span>
        <button class="btn btn--primary" id="new-key" ${quota.atLimit ? `disabled title="${t('keys.revokeFirst')}"` : ''}>${t('keys.create')}</button>
      </div>

      ${quota.atLimit
        ? `<div class="note note--warning">${t('keys.maxReached', { max: exact(quota.max) })}</div>`
        : ''}

      <div class="card card--flush">
        <div class="table-wrap">
          <table class="table">
            <thead><tr>
              <th>${t('metric.key')}</th><th>${t('metric.owner')}</th><th>${t('metric.status')}</th><th>${t('metric.expires')}</th><th>${t('models.title')}</th><th>${t('metric.limits')}</th>
              <th class="hide-sm">${t('metric.lastUsed')}</th><th></th>
            </tr></thead>
            <tbody>${keys.length === 0
              ? `<tr><td colspan="8"><div class="empty"><div class="empty__title">${t('keys.empty')}</div>${
                  state.account?.signedIn === true
                    ? 'Create one to start sending requests.'
                    : 'Log in to create one.'
                }</div></td></tr>`
              : keys.map(row).join('')}</tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="eyebrow">${t('keys.authTitle')}</div>
        <div class="tiny muted mt-2">${t('keys.authEvery')} <code>/v1</code> ${t('keys.authRequestNeedsKey')} <code>/v1/models</code> ${t('keys.authListsOnly')}</div>
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
        const confirmed = await confirmAction({
          title: 'Revoke this key?',
          lines: [
            `“${key.name}” is deleted and stops working immediately.`,
            'This cannot be undone, and anything using this key will need a new one.',
            'Usage already recorded is kept.',
          ],
          confirmLabel: 'Revoke key',
          danger: true,
        });
        if (!confirmed) return;
        await api(`/keys/${id}/revoke`, { method: 'POST' });
        toast(t('keys.revoked'));
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
  name.placeholder = t('form.namePlaceholder');
  name.value = existing?.name ?? '';

  // --- Limits -------------------------------------------------------------
  // `unlimited` is the default: no token or request cap at all.
  const window_ = document.createElement('select');
  window_.className = 'select';
  for (const [value, label] of [
    ['unlimited', t('common.unlimited')],
    ['hour', t('form.perHour')],
    ['day', t('form.perDay')],
    ['month', t('form.perMonth')],
    ['total', t('form.perTotal')],
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
  limitTokens.placeholder = t('form.noLimit');
  limitTokens.value = existing?.limitTokens ?? '';

  const limitRequests = document.createElement('input');
  limitRequests.className = 'input';
  limitRequests.type = 'number';
  limitRequests.min = '0';
  limitRequests.placeholder = t('form.noLimit');
  limitRequests.value = existing?.limitRequests ?? '';

  const tokensField = field(t('form.tokenLimit'), limitTokens, t('form.tokenLimitHint'));
  const requestsField = field(t('form.requestLimit'), limitRequests, t('form.requestLimitHint'));

  // --- Expiry -------------------------------------------------------------
  const expiryMode = document.createElement('select');
  expiryMode.className = 'select';
  for (const [value, label] of [['never', t('form.expiryNever')], ['date', t('form.expiryOnDate')]]) {
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
  const expiryField = field(t('form.expiryDate'), expiryDate, t('form.expiryHint'));

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
    pill.title = model.premier ? 'Premium — billed in Credits' : 'Free — unmetered';
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
    hint.textContent = t('models.unavailable');
    modelList.appendChild(hint);
  }

  const modelsField = field(
    t('form.allowedModels'),
    modelList,
    t('form.allowedModelsHint'),
  );

  const quickPicks = document.createElement('div');
  quickPicks.className = 'row';
  quickPicks.style.gap = '6px';
  const freeButton = document.createElement('button');
  freeButton.type = 'button';
  freeButton.className = 'btn btn--secondary btn--sm';
  freeButton.textContent = t('form.selectFree');
  const allButton = document.createElement('button');
  allButton.type = 'button';
  allButton.className = 'btn btn--secondary btn--sm';
  allButton.textContent = t('common.allModels');
  allButton.title = t('form.unrestricted');
  const noneButton = document.createElement('button');
  noneButton.type = 'button';
  noneButton.className = 'btn btn--secondary btn--sm';
  noneButton.textContent = t('common.clear');
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
  submit.textContent = existing ? 'Save changes' : t('keys.create');
  const cancel = document.createElement('button');
  cancel.className = 'btn btn--secondary';
  cancel.textContent = t('common.cancel');
  cancel.addEventListener('click', closeModal);

  const actions = document.createElement('div');
  actions.className = 'row';
  actions.style.justifyContent = 'flex-end';
  actions.append(cancel, submit);

  form.append(
    field(t('form.name'), name, t('form.nameHint')),
    field(t('form.limitWindow'), window_, t('form.limitWindowHint')),
    tokensField,
    requestsField,
    field(t('form.expires'), expiryMode),
    expiryField,
    quickPicks,
    modelsField,
    error,
    actions,
  );

  openModal(existing ? t('keys.editTitle') : t('keys.createTitle'), form);

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
      error.textContent = t('keys.nameRequired');
      error.hidden = false;
      return;
    }
    submit.disabled = true;
    try {
      if (existing) {
        await api(`/keys/${existing.id}`, { method: 'PATCH', body });
        closeModal();
        toast(t('keys.updated'));
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
  note.textContent = t('keys.copyNow');

  const done = document.createElement('button');
  done.className = 'btn btn--primary';
  done.textContent = t('common.done');
  done.addEventListener('click', () => {
    closeModal();
    toast(t('keys.createdTitle', { name }));
    onDone();
  });

  const actions = document.createElement('div');
  actions.className = 'row';
  actions.style.justifyContent = 'flex-end';
  actions.appendChild(done);

  wrap.append(note, snippet(plaintext), actions);
  openModal(t('keys.createdTitle', { name }), wrap);
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

  /*
   * The catalog needs an identity, so the load at startup is refused for a visitor who is
   * not signed in yet — and `state.models` stays empty. Signing in without reloading the
   * page then left the key form with no models to choose from, which is what this fixes.
   * The `length === 0` guard makes it a no-op once the catalog is in hand.
   */
  if (state.account?.signedIn === true && state.models.length === 0) {
    await loadModels().catch(() => []);
  }

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

/* Kick off: language, account and catalog in parallel, then the first view. */
(async () => {
  // The language comes first: everything rendered below is a translated string, and a
  // view painted in the wrong language and then repainted is worse than a short wait.
  await loadLocale(detectLocale());
  applyStaticText();
  renderLocaleButton();
  await Promise.all([loadAccount(), loadModels().catch(() => [])]);
  // DeepAI's callback redirects here with ?logged-in=1; confirm it once.
  if (new URLSearchParams(location.search).has('logged-in')) {
    if (state.account?.signedIn === true) toast(t('signin.loggedInToast'));
    history.replaceState(null, '', `${location.pathname}${location.hash}`);
  }
  await render({ refreshAccount: false });
  // Keep the balance reasonably fresh while the tab is open.
  setInterval(() => { void loadAccount(); }, 60_000);
})();
