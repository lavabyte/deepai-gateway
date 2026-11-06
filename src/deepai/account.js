/**
 * DeepAI account details: reading a key's balance, naming its owner, and parsing
 * the account JSON a visitor copies out of their own browser.
 *
 * **Why there is no browser sign-in here.** DeepAI implements RFC 8252 for a
 * native client: the desktop app binds `127.0.0.1:0`, hands DeepAI the ephemeral
 * port, and DeepAI hard-codes the loopback host when it builds the redirect.
 * `port` is parsed as a plain TCP port - a full URL, a `host:port` pair, `0`,
 * `-1`, an empty value and a path suffix are each rejected with
 * `400 Invalid desktop sign-in request` - so no parameter exists through which a
 * public origin could be passed, and a browser on any other machine cannot open
 * the redirect at all.
 *
 * So the gateway does not try. The visitor signs in at `deepai.org` as usual -
 * including with a Google or Apple account, which has no password to give - and
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
 * Read the account allowance (`GET /deepai_code/theos`). This is the Credits
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
    /*
     * A retired lane revision is answered before the key is read, and it used to arrive here
     * as `HTTP 426` - which `checkPastedKey` turns into "could not reach DeepAI". DeepAI was
     * reached, and it said something specific: this gateway is sending a version it has
     * retired. Reported as its own state so the reader is told that, rather than sent to
     * retry a request that will fail identically every time.
     */
    if (allowanceResponse.status === 426) {
      return { ok: false, error: 'the lane revision is retired' };
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
 *   | {ok: false, reason: 'rejected'|'not-for-code'|'lane-outdated'|'unreachable', error?: string}>}
 */
export async function checkPastedKey(apiKey, signal) {
  const check = await checkKey(apiKey, signal);
  if (check.ok === true) {
    return { ok: true, allowance: check.allowance, isPro: check.isPro === true };
  }
  if (check.error === 'the lane revision is retired') {
    // DeepAI's verdict, but about this gateway rather than about the key.
    return { ok: false, reason: 'lane-outdated', error: check.error };
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


