/**
 * The check-in handshake DeepAI's Code lane expects from a real client.
 *
 * Read out of the desktop app (0.3.38, `src/deepai/api.ts`), because none of it is documented
 * and all of it is load-bearing on the server side:
 *
 *   - `GET /deepai_code/theos` is a *check-in*, not just a balance read. Its answer carries
 *     `check_in: { nonce, seconds }`, and the app keeps that nonce and sends it back as
 *     `X-DeepAI-Code-Check-In` on its later requests - refreshing it once half its lifetime
 *     has passed, because it is what says "this client is still an instance of the app".
 *   - every request also carries `X-DeepAI-Code-Beacon`, a short self-description
 *     (`v=<version>;up=<seconds>;pi=<0|1>;focus=<0|1>`) the app builds on each call.
 *
 * The app treats a `/theos` answer with no check-in as a failure ("The server did not return
 * a check-in"), and treats a server that answers `enabled: false` (or no `lane_version`) as a
 * legacy one it stops demanding one from. This module is the same state machine, minus the
 * parts that only make sense in an app: there is no window to be focused.
 *
 * A gateway that never checked in was a build the server had no reason to treat as a client,
 * which is what a fresh account's key ran into: the key answered on the website and was
 * refused on the lane.
 *
 * @module deepai-gateway/deepai/checkin
 */

/** Header carrying the nonce from the last check-in. As the app spells it. */
export const CHECK_IN_HEADER = 'X-DeepAI-Code-Check-In';

/** Header carrying the per-request self-description. As the app spells it. */
export const BEACON_HEADER = 'X-DeepAI-Code-Beacon';

/**
 * What this deployment calls itself in the beacon.
 *
 * The app sends its own release here (`v=0.3.40`), and the server reads it as "which revision
 * of the protocol is this". This gateway implements the wire of 0.3.40 - the check-in mark,
 * the beacon, lane revision 7 - so it names that revision rather than a version of its own
 * that the server has never heard of, which is a client it has no way to recognise.
 */
const CLIENT_VERSION = '0.3.40';

/** How long an idle relay still counts as "this gateway is serving a model", in ms. */
const RELAY_WINDOW_MS = 10 * 60_000;

/** The last check-in mark, or nothing when the lane has never answered with one. */
let mark = null;

/** When a completion last went upstream: the gateway's answer to the app's `pi` flag. */
let lastRelayAt = 0;

/**
 * Read a check-in out of a `/theos` answer - success or refusal, as the app does.
 *
 * The nonce is 32 hex characters and `seconds` is a positive number of seconds; anything
 * else is a server that does not speak this protocol, which the app treats as legacy.
 *
 * @param {unknown} payload
 * @returns {{nonce: string, seconds: number}|null}
 */
export function readCheckIn(payload) {
  const value = payload?.check_in;
  const nonce = value?.nonce;
  const seconds = value?.seconds;
  if (typeof nonce !== 'string' || !/^[0-9a-f]{32}$/.test(nonce)) return null;
  if (typeof seconds !== 'number' || !(seconds > 0)) return null;
  return { nonce, seconds };
}

/**
 * Keep the check-in a `/theos` answer carried.
 *
 * @param {unknown} payload
 * @param {number} [now]
 * @returns {boolean} whether the answer carried one.
 */
export function noteCheckIn(payload, now = Date.now()) {
  const next = readCheckIn(payload);
  if (next === null) return false;
  mark = { ...next, at: now };
  return true;
}

/** Whether the lane is a legacy one that never answered with a check-in. */
export function hasCheckIn() {
  return mark !== null;
}

/**
 * Record that a completion went upstream, so the beacon can say the gateway is in use.
 *
 * @param {number} [now]
 */
export function noteRelay(now = Date.now()) {
  lastRelayAt = now;
}

/**
 * The beacon: what the app says about itself on each request, in the same shape.
 *
 * `pi` means "a coding session is active", which for a gateway is "a completion went through
 * recently"; `focus` has no meaning without a window, so it is reported as not focused rather
 * than invented.
 *
 * @param {number} [now]
 * @returns {string}
 */
export function beacon(now = Date.now()) {
  const up = Math.floor(process.uptime());
  const relay = lastRelayAt !== 0 && now - lastRelayAt < RELAY_WINDOW_MS ? 1 : 0;
  return `v=${CLIENT_VERSION};up=${up};pi=${relay};focus=0`;
}

/**
 * The headers the app attaches to the requests it makes while checked in.
 *
 * The nonce is sent only while it is fresh: the app refreshes it at half its lifetime, so a
 * nonce older than its `seconds` describes a client that stopped talking to the server, and
 * sending it would be worse than sending nothing.
 *
 * @param {number} [now]
 * @returns {Record<string, string>}
 */
export function beaconHeaders(now = Date.now()) {
  return { [BEACON_HEADER]: beacon(now) };
}

/**
 * The check-in header, when one is fresh.
 *
 * @param {number} [now]
 * @returns {Record<string, string>}
 */
export function checkInHeaders(now = Date.now()) {
  if (mark === null) return {};
  if (now - mark.at > mark.seconds * 1_000) return {};
  return { [CHECK_IN_HEADER]: mark.nonce };
}

/** Forget the mark. For tests, which must not inherit a nonce from an earlier case. */
export function resetCheckIn() {
  mark = null;
  lastRelayAt = 0;
}
