/**
 * The one HTTP channel this gateway reaches DeepAI through.
 *
 * Node's built-in `fetch` pools its connections and closes an idle one after four seconds.
 * A gateway serves turns that are seconds to minutes apart, so in practice almost every
 * request paid a fresh TCP handshake and TLS negotiation before it could even be sent.
 * Measured on the live deployment: one `GET /deepai_code/models` took 960 ms on a cold
 * socket and 270 ms on one that was still open, and the same split showed up in the log as
 * `catalog=962ms` against `catalog=270ms` on consecutive turns. That difference is time a
 * caller spends waiting for nothing at all.
 *
 * So the process fetches through one pool with a keep-alive window measured in minutes.
 * Nothing else changes: the requests, the headers, the streaming and the parsing are the
 * ones already written, and every module keeps calling the global `fetch`.
 *
 * The pool is installed once at boot. It is not a cache and it holds no data between
 * requests - it only keeps the connection, which is what a caller is paying for.
 *
 * @module deepai-gateway/deepai/transport
 */

import { Agent, EnvHttpProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from 'undici';

/**
 * How long a free connection is kept for the next request.
 *
 * Two minutes covers the gap between turns of a conversation, which is the case this
 * exists for. A longer window would hold sockets for a caller who has walked away.
 */
export const KEEP_ALIVE_TIMEOUT_MS = 120_000;

/** Ceiling the agent may negotiate with the server, which measures the same idle window. */
export const KEEP_ALIVE_MAX_TIMEOUT_MS = 600_000;

/** Concurrent connections. DeepAI streams one completion per connection, with no pipelining. */
const CONNECTIONS = 16;

/**
 * The proxy this deployment is told to use, if any.
 *
 * Node's own `fetch` honours the proxy variables when `NODE_USE_ENV_PROXY` is set, and the
 * desktop app does the same on Linux; a gateway can sit behind an egress proxy for the same
 * reason, so the pool does too. `NODE_USE_ENV_PROXY=0` turns it off explicitly, exactly as it
 * does for the built-in client.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string} the proxy URL, or '' for a direct connection.
 */
function proxyFromEnv(env) {
  if (env.NODE_USE_ENV_PROXY === '0') return '';
  return env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY || '';
}

/**
 * Install the pool, and point the process's `fetch` at it.
 *
 * Assigning the global is what keeps every call site - the two transports, the catalog, the
 * allowance read, the sign-in exchange, the price refresh - on this one channel without
 * rewriting any of them, and it keeps the tests able to stand in for the network by replacing
 * that same global.
 *
 * @param {{env?: NodeJS.ProcessEnv, log?: (message: string) => void}} [options]
 * @returns {import('undici').Dispatcher} the installed dispatcher.
 */
export function installUpstreamPool(options = {}) {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  const settings = {
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
    keepAliveMaxTimeout: KEEP_ALIVE_MAX_TIMEOUT_MS,
    connections: CONNECTIONS,
    pipelining: 1,
  };
  const proxy = proxyFromEnv(env);
  const dispatcher = proxy === '' ? new Agent(settings) : new EnvHttpProxyAgent(settings);
  setGlobalDispatcher(dispatcher);
  globalThis.fetch = undiciFetch;
  log(proxy === ''
    ? `upstream channel: one keep-alive pool, ${KEEP_ALIVE_TIMEOUT_MS / 1000}s idle window`
    : `upstream channel: one keep-alive pool through ${proxy}, ${KEEP_ALIVE_TIMEOUT_MS / 1000}s idle window`);
  return dispatcher;
}
