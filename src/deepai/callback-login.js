/**
 * DeepAI's own browser sign-in, finishing at `/callback` on this gateway.
 *
 * DeepAI implements RFC 8252 for a native client:
 * it always builds `http://127.0.0.1:<port>/callback` as the redirect, and nothing in the
 * request can move that host - `port` is parsed as a plain integer, so a URL, a `host:port`
 * pair, `0`, `-1` and an empty value are each rejected with `400 Invalid desktop sign-in
 * request`. A **privileged port is refused as well**, so a gateway listening on 80 or 443
 * cannot name the port it is actually on; `advertisedCallbackPort` answers with a normal
 * one instead, which costs nothing because the port only decides where a redirect that
 * usually cannot open would have gone. The redirect therefore only resolves when the
 * browser reaches that address as this gateway: the browser runs on this host, or the port
 * is forwarded to it.
 *
 * That is why the flow ends by asking for the address back. The browser lands on a page that
 * cannot load, the address carries the one-shot `code` and the `state` this gateway
 * generated, and pasting it completes the sign-in from anywhere - no port forward, no tunnel,
 * and no password typed into this gateway.
 *
 * A pending attempt is keyed by its own `state` - 256 random bits the gateway generates
 * and DeepAI echoes back - rather than by a per-browser cookie. The state IS the capability:
 * no other visitor can name it, so nobody can complete someone else's attempt, and the
 * paste-back path can find its flow from the address alone.
 *
 * @module deepai-gateway/deepai/callback-login
 */

import { randomBytes } from 'node:crypto';
import express from 'express';
import { API_ORIGIN, laneHeaders } from './wire.js';
import { usernameForKey } from './account.js';
import { noteCheckIn } from './checkin.js';
import { readAccount } from '../store.js';
import { completeLogin } from '../api/admin.js';

/** How long one attempt stays redeemable. */
const FLOW_TTL_MS = 5 * 60_000;

/** Ceiling on concurrent attempts, so an unauthenticated route cannot grow state freely. */
const MAX_FLOWS = 64;

/**
 * The port advertised when this gateway's own port cannot be named to DeepAI.
 *
 * It is the port this project listens on by default, so the address shown to the visitor is
 * the one they would see from a normal deployment.
 */
export const FALLBACK_CALLBACK_PORT = 8787;

/**
 * The port to put in the sign-in request.
 *
 * DeepAI refuses the whole request when `port` is not a port a native app could plausibly be
 * listening on: below 1024 it is privileged and it says `400 Invalid desktop sign-in
 * request`, and `0` or a negative is not a port at all. A gateway is often put on 80 or 443,
 * and then there is no valid value to send - so a normal port is sent in its place.
 *
 * Nothing depends on the substitution. DeepAI only uses the port to build a redirect to
 * `127.0.0.1`, which generally cannot load; the sign-in is completed by pasting the address
 * back, and that is redeemed by the `state` alone, never by the port. When the browser *can*
 * reach loopback, the fallback simply means it reaches the default port rather than the one
 * this gateway is on - so the paste is still the way through, which it already was.
 *
 * @param {unknown} localPort - the port this gateway is listening on.
 * @returns {number} a port DeepAI will accept.
 */
export function advertisedCallbackPort(localPort) {
  const port = Number(localPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return FALLBACK_CALLBACK_PORT;
  return port;
}

/**
 * The address DeepAI will build, from the port it is given.
 *
 * Exported so the dashboard can show the visitor what to look for in the address bar: the
 * sign-in field used to name this project's default port instead of the one the deployment
 * actually listens on, which is the one DeepAI is told about.
 */
export function loopbackCallbackUrl(port) {
  return `http://127.0.0.1:${Number(port) || 0}/callback`;
}

/**
 * Pull `code` and `state` out of whatever a visitor pasted.
 *
 * The redirect that failed to open is still in the address bar, so the usual input is a
 * whole URL. A bare code is rejected: without the `state` nothing proves the code was
 * minted for this attempt, which is what the parameter exists to prevent.
 *
 * The reasons are specific because they are shown to the visitor as instructions -
 * "the address is cut off" is actionable, "invalid input" is not.
 *
 * @param {unknown} input
 * @returns {{ok: true, code: string, state: string}
 *   | {ok: false, reason: 'not-an-address'|'too-long'|'no-code'|'no-state'}}
 */
export function parseCallbackInput(input) {
  if (typeof input !== 'string') return { ok: false, reason: 'not-an-address' };
  // Browsers, chat clients and terminals like to hand back a quoted link.
  const text = input.trim().replace(/^[<'"]+|[>'"]+$/g, '').trim();
  if (text === '') return { ok: false, reason: 'not-an-address' };
  if (text.length > 8192) return { ok: false, reason: 'too-long' };

  let params;
  try {
    // A base is supplied so a bare `?code=...&state=...` fragment also parses.
    params = new URL(text, 'http://127.0.0.1').searchParams;
  } catch {
    return { ok: false, reason: 'not-an-address' };
  }
  if (!/[?&](code|state)=/.test(text)) return { ok: false, reason: 'not-an-address' };

  const code = params.get('code') ?? '';
  const state = params.get('state') ?? '';
  if (code === '') return { ok: false, reason: 'no-code' };
  if (state === '') return { ok: false, reason: 'no-state' };
  return { ok: true, code, state };
}

/**
 * Connection failures worth one more try, as the app classifies them.
 *
 * These all happen *before* DeepAI has seen the request, so repeating them cannot burn the
 * code. Everything else - a timeout, a reset mid-flight - may have already minted the key,
 * and the app does not retry those either: a second exchange of the same one-shot code is
 * refused, and the key the first one produced is gone.
 */
const RETRYABLE_CONNECT_CODES = new Set([
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

/** Did this failure happen before anything was sent? */
function failedBeforeSending(cause) {
  if (cause instanceof AggregateError) {
    return cause.errors.length > 0 && cause.errors.every(failedBeforeSending);
  }
  if (cause === null || typeof cause !== 'object' || !('code' in cause)) return false;
  if (cause.code === 'ETIMEDOUT') return cause.syscall === 'connect';
  return RETRYABLE_CONNECT_CODES.has(String(cause.code));
}

/**
 * Redeem a one-shot sign-in code for the account's key.
 *
 * Reproduces the app's exchange, request for request: only a content type, `redirect: error`,
 * a 20 second deadline, exactly one retry and only for a failure that happened before the
 * request was sent. The retry is not politeness - the code is one-shot, so a pre-send failure
 * that is not repeated is a sign-in the visitor has to start over.
 *
 * @param {string} code
 * @returns {Promise<{apiKey: string, username: string, isPro: boolean}>}
 * @throws {Error & {exchangeStatus?: number}} with the status DeepAI answered, when it did.
 */
async function exchangeCode(code) {
  const deadline = AbortSignal.timeout(20_000);
  const send = () => fetch(`${API_ORIGIN}/deepai_code/desktop_auth/exchange/`, {
    method: 'POST',
    // Only a content type, exactly as the app's own exchange call sends: this endpoint
    // neither reads a lane revision nor needs a machine identity.
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
    redirect: 'error',
    signal: deadline,
  });
  let response;
  try {
    response = await send();
  } catch (error) {
    if (deadline.aborted || !failedBeforeSending(error?.cause)) throw error;
    response = await send();
  }
  if (!response.ok) {
    const failure = new Error(`DeepAI sign-in exchange: HTTP ${response.status}`);
    failure.exchangeStatus = response.status;
    throw failure;
  }
  const data = await response.json();
  /*
   * The key is written into a header on every later call, so a newline in it is not a key:
   * it is a response this gateway must not store. The app validates the same way.
   */
  if (data === null || typeof data !== 'object'
    || typeof data.api_key !== 'string' || data.api_key === '' || /[\r\n]/.test(data.api_key)) {
    throw new Error('DeepAI sign-in returned an invalid response');
  }
  return {
    apiKey: data.api_key,
    username: typeof data.username === 'string' ? data.username : '',
    isPro: data.is_pro === true,
  };
}

/**
 * Ask DeepAI what the key it just returned is actually good for.
 *
 * The app reads the catalog here, and so did this, until a real account proved what that is
 * worth: `/models` answers 200 with the whole catalog for an address that `/chat/completions`
 * refuses outright. So the catalog is not evidence of anything, and a verdict drawn from it is
 * worse than no verdict - it says "signed in" to somebody who cannot send a single request.
 *
 * The one answer worth acting on is DeepAI's own `social_login_required`, which is not about
 * the key at all: DeepAI Code is for accounts signed in with Google or Apple, and a password
 * account is refused by name. That is a sentence the visitor can act on, so it is the one
 * thing this reports. Everything else stays unsaid.
 *
 * @param {string} apiKey
 * @returns {Promise<'social-login-required'|undefined>}
 */
async function codeAccessAfterSignIn(apiKey) {
  try {
    const response = await fetch(`${API_ORIGIN}/deepai_code/theos`, {
      headers: { ...laneHeaders(), 'Api-Key': apiKey },
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    });
    const body = await response.json().catch(() => undefined);
    // The refusal carries a check-in mark too, and keeping it is what makes the next call a
    // client's call rather than a stranger's.
    noteCheckIn(body);
    return body?.error?.code === 'social_login_required' ? 'social-login-required' : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a visitor whose account DeepAI Code will not serve is told.
 *
 * The same words on the HTML page and in the JSON: DeepAI Code is for accounts signed in with
 * Google or Apple, and an address registered with a password is not something this gateway
 * can fix, fake or work around. Saying "signed in" and then failing every request would be
 * the same refusal in a friendlier voice.
 */
const NOT_SUPPORTED = 'DeepAI Code is available only to accounts signed in with Google or Apple. '
  + 'This account uses an email address and a password, which DeepAI Code does not support yet. '
  + 'Sign in to DeepAI with Google or Apple instead.';

/**
 * What each completion failure says to the visitor.
 *
 * Read by someone looking at a page that would not load, not at a protocol.
 */
const FAILURES = {
  'not-an-address': [400, 'That does not look like an address. Copy the whole address from the page that did not load - including everything after the "?".'],
  'too-long': [400, 'That is longer than any address DeepAI sends, so something else must have been pasted.'],
  'no-code': [400, 'That address is missing the sign-in code, so it looks cut off. Copy the entire address.'],
  'no-state': [400, 'That address is missing its second half, so it looks cut off. Copy the entire address.'],
  unknown_state: [400, 'That address belongs to a sign-in this gateway is not waiting for. Start a new one and use the address from the page DeepAI sends you to.'],
  exchange_failed: [502, 'DeepAI did not accept that sign-in code. Start the sign-in again.'],
  expired: [410, 'This sign-in timed out. Start it again.'],
};

/**
 * The sign-in routes. They are the only way in, so they are always mounted.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} runtime - `{ log, trustProxy, completeLogin }`
 * @param {object} [options]
 * @param {string} [options.apiOrigin] - overridable so a test can point at a fixture.
 * @returns {{router: import('express').Router, complete: import('express').RequestHandler}}
 *   `router` serves the pages, `complete` finishes an attempt from a pasted address, and
 *   both share one map of pending attempts - which is why this is a factory rather than
 *   two independent routers.
 */
/** Escape text for a page this module writes by hand. */
function escapeText(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function createCallbackLogin(db, runtime, options = {}) {
  const apiOrigin = options.apiOrigin ?? API_ORIGIN;
  const router = express.Router();

  /** One pending attempt per state, with its own deadline. */
  const flows = new Map();

  const forget = (state) => flows.delete(state);

  /** Drop attempts that have aged out, so the map cannot grow with time. */
  const reap = () => {
    const now = Date.now();
    for (const [state, flow] of flows) if (flow.expiresAt <= now) flows.delete(state);
  };

  /**
   * Start an attempt.
   *
   * @param {number} port - the port DeepAI puts in the callback it builds.
   * @param {string} pageBase - origin serving the sign-in page.
   * @returns {{url: string, state: string, expiresAt: number}}
   */
  const begin = (port, pageBase) => {
    reap();
    if (flows.size >= MAX_FLOWS) {
      // The oldest attempt gives way: a person starts one at a time, so reaching this
      // ceiling means something automated is at work.
      const oldest = [...flows.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
      if (oldest !== undefined) flows.delete(oldest[0]);
    }
    const state = randomBytes(32).toString('hex');
    const url = new URL('/deepai_code/desktop_auth/', pageBase);
    // `port` must be a plain integer: it is the only input DeepAI accepts.
    url.search = new URLSearchParams({ state, port: String(port) }).toString();
    const expiresAt = Date.now() + FLOW_TTL_MS;
    flows.set(state, { expiresAt });
    return { url: url.toString(), state, expiresAt };
  };

  /**
   * Redeem a code against the attempt that asked for it.
   *
   * Both entry points funnel through here, so the callback route and the paste-back route
   * cannot drift apart in what they accept.
   *
   * @param {unknown} rawCode
   * @param {unknown} rawState
   * @returns {Promise<{ok: true, apiKey: string, username: string, isPro: boolean}
   *   | {ok: false, reason: string}>}
   */
  const redeem = async (rawCode, rawState) => {
    const code = typeof rawCode === 'string' ? rawCode : '';
    const state = typeof rawState === 'string' ? rawState : '';
    const flow = flows.get(state);
    if (flow === undefined) return { ok: false, reason: 'unknown_state' };
    if (flow.expiresAt <= Date.now()) {
      forget(state);
      return { ok: false, reason: 'expired' };
    }
    if (code === '' || code.length > 4096) return { ok: false, reason: 'no-code' };
    // The code is one-shot, so the attempt ends with this redemption either way.
    forget(state);
    try {
      return { ok: true, ...await exchangeCode(code) };
    } catch (error) {
      runtime.log?.(`callback sign-in exchange failed: ${error?.message ?? error}`);
      return { ok: false, reason: 'exchange_failed' };
    }
  };

  /**
   * Persist the account and hand the browser its session cookie.
   *
   * @returns {boolean} whether the key just exchanged is the one now stored for the account.
   *   A session cookie is handed out either way - it is the read that follows that has to
   *   know - but the caller must not call this a successful sign-in when the key did not land.
   */
  const finish = async (res, account) => {
    const username = account.username !== '' ? account.username : usernameForKey(account.apiKey);
    /*
     * Ask DeepAI about this account before anything is written, because the answer decides
     * whether this sign-in happens at all.
     *
     * DeepAI Code refuses accounts it cannot serve - today every address registered with a
     * password, answered `403 social_login_required` - and that refusal is about the account,
     * not about the key it was just handed. Storing the account anyway would leave somebody
     * signed in to a gateway in which every single request of theirs fails, and no later
     * screen could undo that first impression.
     *
     * So the order matters: probe, then decide. For a refused account nothing is written, no
     * session cookie is set and no row is created. The caller turns this into the one honest
     * answer - "this account is not supported" - instead of a welcome and a silent failure.
     */
    const codeAccess = await codeAccessAfterSignIn(account.apiKey);
    if (codeAccess === 'social-login-required') return { stored: false, codeAccess };

    const completed = completeLogin(db, runtime, {
      apiKey: account.apiKey,
      username,
      isPro: account.isPro,
    }, { secure: runtime.trustProxy === true });
    res.setHeader('set-cookie', completed.cookie);
    const stored = readAccount(db, completed.username)?.apiKey === account.apiKey;
    return { stored, codeAccess };
  };

  /**
   * One sentence on a page, for the browser that lands here.
   *
   * The callback usually cannot load at all - it is a `127.0.0.1` address on a machine the
   * visitor is often not on - so this exists for the case where it does: the browser reaches
   * the gateway, and the page says what happened rather than redirecting into a dashboard that
   * would have to explain it in a toast.
   */
  const page = (title, message) => `<!doctype html>
<meta charset="utf-8"><title>${escapeText(title)}</title>
<body style="font:15px/1.6 system-ui;margin:0;display:grid;place-items:center;min-height:100vh">
<div style="max-width:44ch">
<h1 style="font-size:18px">${escapeText(title)}</h1>
<p>${escapeText(message)}</p>
<p><a href="/">Back to the dashboard</a></p>
</div>`;

  /**
   * Start the sign-in and send the browser to DeepAI.
   *
   * `?json=1` answers with the URL instead of redirecting, which is what the dashboard
   * uses: it can then show the address DeepAI will come back to before navigating.
   */
  router.get('/login', (req, res) => {
    // The port DeepAI is willing to be told, which is not always the one this is on.
    const port = advertisedCallbackPort(req.socket?.localPort);
    const { url } = begin(port, apiOrigin);
    if (req.query.json === '1') {
      return res.json({ ok: true, url, callbackUrl: loopbackCallbackUrl(port), path: '/callback' });
    }
    return res.redirect(302, url);
  });

  /**
   * Where DeepAI sends the browser back.
   *
   * Serves `/callback` and `/auth-callback`: DeepAI builds the first, and the second is
   * what earlier builds of this gateway advertised, so an address already in someone's
   * address bar still works.
   */
  const handleCallback = async (req, res) => {
    const result = await redeem(req.query.code, req.query.state);
    if (result.ok) {
      const { stored, codeAccess } = await finish(res, result);
      // Asked before `stored`: an account DeepAI refuses was never written, and "the key could
      // not be saved" would send the visitor to their operator about something nobody controls.
      if (codeAccess === 'social-login-required') {
        // A refusal, not a warning: nothing was stored and there is no session to hand out.
        runtime.log?.('callback sign-in refused: DeepAI Code does not serve this account');
        return res.status(403).type('html').send(page('This account is not supported', NOT_SUPPORTED));
      }
      if (!stored) return res.status(500).type('html').send(page('Sign-in failed',
        'The DeepAI key could not be saved on this gateway. Sign in again after an operator fixes the database.'));
      runtime.log?.('callback sign-in completed');
      return res.redirect(302, '/');
    }
    const [status, message] = FAILURES[result.reason] ?? [400, 'That sign-in could not be completed.'];
    runtime.log?.(`callback sign-in refused: ${result.reason}`);
    return res.status(status).type('html').send(page('Sign-in failed', message));
  };

  router.get('/callback', handleCallback);
  router.get('/auth-callback', handleCallback);

  /**
   * Finish an attempt from an address the browser could not open.
   *
   * Unauthenticated, because it IS the sign-in. The state in the pasted address is what
   * authorises it; an unknown one is refused like any other bad address, without saying
   * whether an attempt was pending.
   */
  const complete = async (req, res) => {
    const parsed = parseCallbackInput(req.body?.url ?? req.body?.text);
    if (parsed.ok !== true) {
      const [status, message] = FAILURES[parsed.reason] ?? [400, 'That could not be read.'];
      return res.status(status).json({ ok: false, error: message, code: parsed.reason });
    }
    const result = await redeem(parsed.code, parsed.state);
    if (result.ok) {
      /*
       * The key is written, then read back: a sign-in whose key did not reach the database
       * looks exactly like one that worked - the dashboard has a session, the account card is
       * drawn, and every later read refuses the key - so `ok` is not reported unless the row
       * holds what the exchange returned. The failure names the likely cause (a database the
       * process cannot write) rather than leaving the reader to infer it from a refusal later.
       */
      const { stored, codeAccess } = await finish(res, result);
      /*
       * The refused account is answered first: `stored` is false for it too, and saying the
       * database was not writable would send the visitor to their operator about something no
       * operator can change.
       */
      if (codeAccess === 'social-login-required') {
        runtime.log?.('sign-in refused: DeepAI Code does not serve this account');
        return res.status(403).json({ ok: false, error: NOT_SUPPORTED, code: 'social-login-required' });
      }
      if (stored !== true) {
        runtime.log?.('sign-in: the exchanged key could not be stored - refusing to report success');
        return res.status(500).json({
          ok: false,
          error: 'The DeepAI key could not be saved on this gateway (the database is not writable). Sign in again after fixing it.',
          code: 'account_not_saved',
        });
      }
      const username = result.username !== '' ? result.username : usernameForKey(result.apiKey);
      return res.json({ ok: true, username, codeAccess });
    }
    const [status, message] = FAILURES[result.reason] ?? [400, 'That sign-in could not be completed.'];
    return res.status(status).json({ ok: false, error: message, code: result.reason });
  };

  return { router, complete };
}
