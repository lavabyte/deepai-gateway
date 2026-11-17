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
import { noteCheckIn } from './checkin.js';



/**
 * Read the account allowance (`GET /deepai_code/theos`). This is the Credits
 * balance Premier models are billed against.
 *
 * @param {string} apiKey
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ok: boolean, allowance?: object, isPro?: boolean, error?: string,
 *   reason?: 'no-key'|'rejected'|'lane-outdated'|'http'|'unreachable'}>}
 *   `reason` is the machine-readable half, for a caller that shows the visitor a translated
 *   sentence; `error` is the wording for a log.
 */
export async function checkKey(apiKey, signal) {
  if (typeof apiKey !== 'string' || apiKey === '') {
    return { ok: false, reason: 'no-key', error: 'no key stored' };
  }
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

    /*
     * The refusal body carries a check-in too, and the app keeps it from either answer - the
     * mark and the balance come from the same endpoint, so a refused read that still hands out
     * a nonce is a lane that wants this client to keep talking to it.
     */
    if (allowanceResponse.status === 401 || allowanceResponse.status === 403) {
      /*
       * A refusal carries a code that says *which* refusal it is, and they need different
       * fixes. `auth_required` is the key; `machine_required` is this host - the app's own
       * source says the server withholds the daily grant from a build it cannot identify,
       * and answers that way rather than pretending the key is wrong. Reporting both as "the
       * key was rejected" sends the reader to change a key that was never the problem.
       */
      const body = await allowanceResponse.json().catch(() => undefined);
      noteCheckIn(body);
      const code = typeof body?.error?.code === 'string' ? body.error.code : '';
      if (code === 'machine_required') {
        return { ok: false, reason: 'machine-required', error: 'DeepAI requires a machine identity' };
      }
      /*
       * A Code-lane refusal is one of two very different states, and they need different
       * words. DeepAI issues a fresh key on every sign-in and stops accepting the previous
       * one, so a key stored here can be retired by a sign-in that happened somewhere else -
       * the desktop app on the same machine, another browser. Asking the plain website
       * endpoint with the same key tells the two apart: a retired key is refused there too,
       * while a key the site still accepts points at the lane rather than the key.
       */
      if (code === 'auth_required') {
        /*
         * Ask the lane itself before believing it about the account.
         *
         * `/theos` is the *metering* endpoint - it is where the daily grant is counted, and the
         * app's own source says the server withholds the grant from a build it does not
         * recognise. `/models` is the lane's plain answer about whether this key can use DeepAI
         * Code at all. A key that the counter refuses while the catalog comes back with it is a
         * working key with an unreadable balance, and reporting that as "DeepAI rejects this
         * account's key" turned a metering quirk into a dead account - which is exactly what an
         * account signed in by email ran into while the same account worked in the app.
         */
        const lane = await fetch(`${API_ORIGIN}/deepai_code/models`, {
          headers: { ...laneHeaders(), 'Api-Key': apiKey },
          signal: AbortSignal.timeout(10_000),
        }).catch(() => undefined);
        if (lane?.ok === true) {
          const catalog = await lane.json().catch(() => undefined);
          noteCheckIn(catalog);
          return {
            ok: true,
            metering: 'refused',
            allowance: null,
            error: 'the key is accepted, but DeepAI will not report a balance for it',
          };
        }

        /*
         * With its own deadline, not the caller's: the allowance read has just spent part of
         * that budget, and a witness that inherits it gets aborted by the clock rather than
         * answering - which turns "this key is not a Code key" into a vague "rejected".
         */
        const site = await fetch(`${API_ORIGIN}/get_usage_summary`, {
          headers: { accept: 'application/json', 'Api-Key': apiKey },
          signal: AbortSignal.timeout(8_000),
        }).catch(() => undefined);
        const siteAuth = site?.ok
          ? (await site.json().catch(() => undefined))?.is_authenticated
          : undefined;
        if (siteAuth === false) {
          return {
            ok: false,
            reason: 'invalidated',
            error: 'the key is no longer accepted anywhere - DeepAI issues a fresh key on every sign-in and retires the previous one',
          };
        }
        if (siteAuth === true) {
          /*
           * The website still knows this key and the Code lane will not have it. That is not a
           * dead key and not a gateway fault: DeepAI keeps ordinary API keys and DeepAI Code
           * keys apart, and a key issued for the website's own API - or an account without
           * Code access - is refused here however fresh it is. Saying "this account's key was
           * rejected" sent the reader to sign in again, which produces the same refusal.
           */
          return {
            ok: false,
            reason: 'code-access-missing',
            error: 'the key is valid for DeepAI but is not a DeepAI Code key - sign in with an account that has DeepAI Code access',
          };
        }
      }
      return { ok: false, reason: 'rejected', error: 'the key was rejected by DeepAI' };
    }
    /*
     * A retired lane revision is answered before the key is read, and it used to arrive here
     * as `HTTP 426`, which the dashboard reported as "could not reach DeepAI". DeepAI was
     * reached, and it said something specific: this gateway is sending a version it has
     * retired. Reported as its own state so the reader is told that, rather than sent to
     * retry a request that will fail identically every time.
     */
    if (allowanceResponse.status === 426) {
      return { ok: false, reason: 'lane-outdated', error: 'the lane revision is retired' };
    }
    if (!allowanceResponse.ok) {
      return { ok: false, reason: 'http', error: `HTTP ${allowanceResponse.status}` };
    }

    const data = await allowanceResponse.json().catch(() => ({}));
    noteCheckIn(data);
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
    return { ok: false, reason: 'unreachable', error: String(error?.message ?? error) };
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



