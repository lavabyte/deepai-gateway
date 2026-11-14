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
import { API_ORIGIN } from './wire.js';
import { usernameForKey } from './account.js';
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
 * Redeem a one-shot sign-in code for the account's key.
 *
 * @param {string} code
 * @returns {Promise<{apiKey: string, username: string, isPro: boolean}>}
 */
async function exchangeCode(code) {
  const response = await fetch(`${API_ORIGIN}/deepai_code/desktop_auth/exchange/`, {
    method: 'POST',
    // Only a content type, exactly as the app's own exchange call sends: this endpoint
    // neither reads a lane revision nor needs a machine identity.
    headers: { 'content-type': 'application/json' },
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

  /** Persist the account and hand the browser its session cookie. */
  const finish = (res, account) => {
    const completed = completeLogin(db, runtime, {
      apiKey: account.apiKey,
      username: account.username !== '' ? account.username : usernameForKey(account.apiKey),
      isPro: account.isPro,
    }, { secure: runtime.trustProxy === true });
    res.setHeader('set-cookie', completed.cookie);
  };

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
      finish(res, result);
      runtime.log?.('callback sign-in completed');
      return res.redirect(302, '/');
    }
    const [status, message] = FAILURES[result.reason] ?? [400, 'That sign-in could not be completed.'];
    runtime.log?.(`callback sign-in refused: ${result.reason}`);
    return res.status(status).type('html').send(`<!doctype html>
<meta charset="utf-8"><title>Sign-in failed</title>
<body style="font:15px/1.6 system-ui;margin:0;display:grid;place-items:center;min-height:100vh">
<div style="max-width:44ch">
<h1 style="font-size:18px">Sign-in failed</h1>
<p>${message.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</p>
<p><a href="/">Back to the dashboard</a></p>
</div>`);
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
      finish(res, result);
      const username = result.username !== '' ? result.username : usernameForKey(result.apiKey);
      return res.json({ ok: true, username });
    }
    const [status, message] = FAILURES[result.reason] ?? [400, 'That sign-in could not be completed.'];
    return res.status(status).json({ ok: false, error: message, code: result.reason });
  };

  return { router, complete };
}
