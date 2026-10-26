/**
 * DeepAI account details: reading a key's balance, naming its owner, and parsing
 * the account JSON a visitor copies out of their own browser.
 *
 * **Why there is no browser sign-in here.** DeepAI implements RFC 8252 for a
 * native client: the desktop app binds `127.0.0.1:0`, hands DeepAI the ephemeral
 * port, and DeepAI hard-codes the loopback host when it builds the redirect.
 * `port` is parsed as a plain TCP port — a full URL, a `host:port` pair, `0`,
 * `-1`, an empty value and a path suffix are each rejected with
 * `400 Invalid desktop sign-in request` — so no parameter exists through which a
 * public origin could be passed, and a browser on any other machine cannot open
 * the redirect at all.
 *
 * So the gateway does not try. The visitor signs in at `deepai.org` as usual —
 * including with a Google or Apple account, which has no password to give — and
 * reads the account JSON out of
 * `https://api.deepai.org/daily-time-sync/user/`. That JSON carries both the
 * account's `email` and its `userprofile.api_key`, so nothing has to be typed
 * from memory and nothing has to be trusted but the key, which DeepAI validates.
 *
 * @module deepai-gateway/deepai/account
 */

import { createHash } from 'node:crypto';
import { API_ORIGIN, laneHeaders } from './wire.js';



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

/**
 * The account a pasted API key belongs to.
 *
 * DeepAI keys carry no identity: `/deepai_code/theos` and `/get_usage_summary`
 * both answer with allowance only, and no endpoint reports who the key belongs to.
 * So the owner has to come from the key itself.
 *
 * That is a security property, not a convenience. `api_keys.owner_username`
 * decides who sees and pays for a key, so if a visitor could *choose* their owner
 * name they could type someone else's and inherit their keys. Deriving it from the
 * key makes the mapping one-to-one: the same key always resolves to the same
 * account, and no key can resolve to another's.
 *
 * @param {string} apiKey
 * @returns {string} a stable, non-reversible owner name.
 */
export function usernameForKey(apiKey) {
  const digest = createHash('sha256').update(String(apiKey), 'utf8').digest('hex');
  return `key-${digest.slice(0, 16)}`;
}

/**
 * Validate a key a visitor pasted, saying precisely what is wrong when it is not
 * usable.
 *
 * A key that DeepAI refuses for the Code lane is worth telling apart from a key
 * that is simply wrong: `deepai.org` issues a key for the public model API, and
 * that key is not automatically enabled for DeepAI Code. That is the likeliest
 * failure of all, and the two need different advice.
 *
 * @param {string} apiKey
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ok: true, allowance: object, isPro: boolean}
 *   | {ok: false, reason: 'rejected'|'not-for-code'|'unreachable', error?: string}>}
 */
export async function checkPastedKey(apiKey, signal) {
  const check = await checkKey(apiKey, signal);
  if (check.ok === true) {
    return { ok: true, allowance: check.allowance, isPro: check.isPro === true };
  }
  if (check.error !== 'the key was rejected') {
    // Not a verdict from DeepAI, so do not report it as one.
    return { ok: false, reason: 'unreachable', error: check.error };
  }

  // The Code lane refused it. Ask the public API whether the key works at all.
  try {
    const response = await fetch(`${API_ORIGIN}/get_usage_summary`, {
      headers: { ...laneHeaders(), 'Api-Key': apiKey },
      signal,
    });
    const data = response.ok ? await response.json().catch(() => undefined) : undefined;
    if (data?.is_authenticated === true) return { ok: false, reason: 'not-for-code' };
  } catch {
    /* fall through: treated as simply rejected */
  }
  return { ok: false, reason: 'rejected' };
}


/**
 * Read the account JSON a visitor pasted out of their own browser.
 *
 * The shape is the answer to `GET /daily-time-sync/user/`, which is the one place a
 * DeepAI key and the account's own email appear together. A visitor who signs in with
 * Google or Apple has no password to give, so this is how they hand over the key.
 *
 * Parsing is deliberately forgiving: a console prints a copied string with its quotes
 * still around it, and a paste can pick up a stray line. The only thing that must be
 * present is the key, because everything else can be re-derived.
 *
 * @param {unknown} input
 * @returns {{ok: true, apiKey: string, email?: string}
 *   | {ok: false, reason: 'empty'|'too-long'|'not-json'|'no-key'}}
 */
export function parseAccountPaste(input) {
  if (typeof input !== 'string') return { ok: false, reason: 'empty' };
  let text = input.trim();
  if (text === '') return { ok: false, reason: 'empty' };
  if (text.length > 65536) return { ok: false, reason: 'too-long' };

  // A copied console string keeps its quotes.
  if (text.length > 1
    && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    text = text.slice(1, -1).trim();
  }
  /*
   * Anything around the object — a log prefix, a trailing `undefined` line — is
   * ignored. Every `{` is tried in turn rather than only the first, because a console
   * can print more than one thing and a stray brace before the object would otherwise
   * make the whole paste unreadable. The candidate count is bounded so a pathological
   * paste cannot turn this into work.
   */
  const end = text.lastIndexOf('}');
  if (end <= 0) return { ok: false, reason: 'not-json' };

  let data;
  let from = -1;
  for (let tries = 0; tries < 64; tries += 1) {
    const start = text.indexOf('{', from + 1);
    if (start === -1 || start >= end) break;
    from = start;
    try {
      data = JSON.parse(text.slice(start, end + 1));
      break;
    } catch {
      /* try the next candidate */
    }
  }
  if (data === undefined) return { ok: false, reason: 'not-json' };

  const apiKey = typeof data?.userprofile?.api_key === 'string' ? data.userprofile.api_key.trim() : '';
  if (apiKey === '') return { ok: false, reason: 'no-key' };
  const email = typeof data?.email === 'string' ? data.email.trim() : '';
  return { ok: true, apiKey, ...(email === '' ? {} : { email }) };
}
