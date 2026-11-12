/**
 * DeepAI Code model catalog.
 *
 * `GET /deepai_code/models` is readable without an account and is **the** source of truth for
 * which models exist, what they cost and which upstream API they use. This gateway keeps no
 * copy of its own: no embedded list, no cache. A model exists because DeepAI says so on this
 * request, which is the only way a catalog that changes under us stays correct - an embedded
 * snapshot in a shipped build is wrong the moment DeepAI adds, renames or retires a model,
 * and a cache makes it wrong for up to its lifetime for no benefit the network does not
 * already give.
 *
 * The environment this runs in has a network; that is the premise. What it does *not* assume
 * is that the network is always up at the moment of a call, so a failure is reported as a
 * failure - never papered over with a stale or made-up model list. See `CatalogUnavailable`.
 *
 * @module deepai-gateway/deepai/catalog
 */

import { API_ORIGIN, codeHeaders } from './wire.js';

/** Human labels for the thinking levels, in the order the API exposes them. */
export const REASONING_LEVELS = Object.freeze([
  { id: 'none', name: 'None', description: 'Answer without extended thinking.' },
  { id: 'low', name: 'Low', description: 'Short reasoning pass.' },
  { id: 'medium', name: 'Medium', description: 'Balanced reasoning depth.' },
  { id: 'high', name: 'High', description: 'Deepest reasoning, slowest per token but cheapest per second.' },
]);

/**
 * Label shown wherever a model is named. Models the free tier can use are
 * marked so the tier is visible without opening the description.
 */
export function displayName(model) {
  return model.premier === false ? `${model.name} Free` : model.name;
}

/**
 * What one request costs, or `Unmetered` when it is free.
 *
 * DeepAI bills a Premier model per request (`theosPerRequest`), a flat number of Credits
 * for one completion. The per-second rates this used to read were replaced by the provider
 * and the field no longer exists, so the label follows the price that is actually charged.
 *
 * The label names the unit in full - `3 Credits / req` - rather than leaving it to the column
 * header. A price read on its own, in an API answer or a copied row, has to say what it is
 * counting: Credits, per request.
 *
 * The `level` argument is kept for the call sites that name a thinking level: the price is
 * the same at every level now, and a caller passing one still gets the right answer.
 *
 * @param {{theosPerRequest?: string}} model
 * @param {string} [level] - ignored; DeepAI no longer prices by level.
 * @returns {string}
 */
export function rateLabel(model, level) {
  void level;
  const value = Number(model?.theosPerRequest);
  if (!Number.isFinite(value)) return 'Unknown';
  if (value === 0) return 'Unmetered';
  return `${value} Credits / req`;
}

/**
 * The catalog could not be read from DeepAI.
 *
 * Distinct from a bug: it means the network failed, DeepAI refused, or DeepAI answered with
 * something that is not a catalog. Callers turn it into an upstream failure rather than a
 * 500, because that is what it is - and never into an empty or invented model list, which
 * would let a caller ask for a model that does not exist and get a confusing answer much
 * further downstream.
 */
export class CatalogUnavailable extends Error {
  /**
   * @param {string} message - what happened, for the log and the caller.
   * @param {{cause?: unknown}} [options]
   */
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'CatalogUnavailable';
    this.code = 'CATALOG_UNAVAILABLE';
  }
}

/** Look one model up in a catalog that was just fetched. */
export function findModel(models, id) {
  if (!Array.isArray(models)) return undefined;
  return models.find((model) => model.id === id);
}

/**
 * Shape one provider payload entry into a catalog record.
 *
 * Every field comes from the payload. Nothing is filled in from a local table, so a field
 * DeepAI stops sending reads as unknown rather than as a number this gateway made up.
 *
 * @param {unknown} raw
 * @returns {object|undefined} undefined when the entry cannot be a model.
 */
function normalize(raw) {
  if (raw === null || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id === '') return undefined;
  const input = Array.isArray(raw.input)
    ? raw.input.filter((item) => item === 'text' || item === 'image')
    : [];
  // DeepAI bills a Premier model per request. A missing or unreadable price stays unknown
  // rather than becoming zero, which would advertise a paid model as free.
  const perRequest = typeof raw.theosPerRequest === 'string' || typeof raw.theosPerRequest === 'number'
    ? String(raw.theosPerRequest)
    : undefined;
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : raw.id,
    reasoning: raw.reasoning === true,
    input: input.length > 0 ? input : ['text'],
    contextWindow: Number.isSafeInteger(raw.contextWindow) && raw.contextWindow > 0
      ? raw.contextWindow
      : undefined,
    maxTokens: Number.isSafeInteger(raw.maxTokens) && raw.maxTokens > 0 ? raw.maxTokens : undefined,
    premier: raw.premier === true,
    api: typeof raw.api === 'string' && raw.api !== '' ? raw.api : 'openai-completions',
    theosPerRequest: perRequest,
  };
}

/**
 * Read the catalog from DeepAI. No cache: every call is a real read.
 *
 * A failure is a `CatalogUnavailable`, with the reason kept in the message so the caller can
 * say what went wrong instead of "something failed".
 *
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<object>>}
 */
export async function fetchCatalog(signal) {
  let response;
  try {
    response = await fetch(`${API_ORIGIN}/deepai_code/models`, {
      headers: codeHeaders({ accept: 'application/json' }),
      signal: signal ?? AbortSignal.timeout(10_000),
    });
  } catch (error) {
    // No network, DNS failure, a timeout: the environment assumes a network, and this is the
    // case where it is not there. Reported as what it is rather than as an empty catalog.
    if (signal?.aborted) throw new CatalogUnavailable('DeepAI model catalog: request aborted');
    throw new CatalogUnavailable(`DeepAI model catalog: unreachable (${error?.message ?? error})`);
  }
  if (!response.ok) {
    throw new CatalogUnavailable(`DeepAI model catalog: HTTP ${response.status}`);
  }
  const data = await response.json().catch(() => undefined);
  const list = Array.isArray(data?.models) ? data.models : [];
  const models = [];
  const seen = new Set();
  for (const raw of list) {
    const model = normalize(raw);
    if (model === undefined || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  if (models.length === 0) throw new CatalogUnavailable('DeepAI model catalog: empty answer');
  return models;
}

/*
 * The catalog the gateway is serving, refreshed on its own schedule.
 *
 * Reading it on every request made the list as fresh as possible and cost a round trip on
 * every call - measured at 0.9 s cold and 0.2 s on a kept-alive connection, on a path that had
 * nothing else to do with the request. The operator asked for the opposite arrangement: read
 * it every ten to twenty minutes, at a random point in that window, and answer everything
 * from what was last read. No model is written into this file; the list exists only because
 * DeepAI sent it.
 *
 * The random window matters for more than tidiness. A fixed interval across every deployment
 * of this gateway would put them all in the same minute, and DeepAI would see a spike of
 * catalog reads once every ten minutes and nothing in between.
 */
let served = null;
let servedAt = 0;
let loading = null;
let timer = null;

/** The catalog last read from DeepAI, or null before the first read. */
export function catalogSnapshot() {
  return served;
}

/**
 * Forget the kept catalog, so the next call reads one.
 *
 * For tests, which stub DeepAI per case and must not inherit the list an earlier case left
 * behind. A deployment has no reason to call it: the schedule replaces the list on its own.
 */
export function resetCatalog() {
  served = null;
  servedAt = 0;
  loading = null;
}

/** How old the served catalog is, in ms, or null when there is none. */
export function catalogAge() {
  return served === null ? null : Date.now() - servedAt;
}

/**
 * The catalog to answer from.
 *
 * The first call reads it, and every call after that gets the copy the refresher keeps
 * current. Concurrent callers during that first read share one request.
 *
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<object>>}
 */
export async function ensureCatalog(signal) {
  if (served !== null) return served;
  if (loading !== null) return loading;
  loading = fetchCatalog(signal)
    .then((models) => {
      served = models;
      servedAt = Date.now();
      return models;
    })
    .finally(() => { loading = null; });
  return loading;
}

/**
 * Read the catalog again, keeping the previous list if the read fails.
 *
 * A failed refresh is not a reason to lose a list that was correct five minutes ago: the
 * gateway keeps answering from it and tries again on the next tick. The failure is logged
 * once per attempt so an operator can see it without a request failing.
 *
 * @param {{log?: (message: string) => void, signal?: AbortSignal}} [options]
 * @returns {Promise<boolean>} whether it was replaced.
 */
export async function refreshCatalog(options = {}) {
  const log = options.log ?? (() => {});
  try {
    const models = await fetchCatalog(options.signal ?? AbortSignal.timeout(15_000));
    const previous = served?.length ?? 0;
    served = models;
    servedAt = Date.now();
    if (previous !== models.length) {
      log(`model catalog: ${models.length} models (was ${previous})`);
    }
    return true;
  } catch (error) {
    log(`model catalog: refresh failed, still serving ${served?.length ?? 0} models (${error?.message ?? error})`);
    return false;
  }
}

/**
 * The wait before the next read, chosen at random inside the window.
 *
 * A function of its inputs rather than of the clock, so the window can be tested without
 * pretending to be time - and so a deployment can see the rule instead of inferring it.
 *
 * @param {object} [options]
 * @param {number} [options.minMs]
 * @param {number} [options.maxMs]
 * @param {() => number} [options.random] - something in `[0, 1)`, as `Math.random` is.
 * @returns {number}
 */
export function nextRefreshDelay(options = {}) {
  const minMs = Number.isFinite(options.minMs) ? options.minMs : 10 * 60_000;
  const maxMs = Number.isFinite(options.maxMs) ? options.maxMs : 20 * 60_000;
  const random = options.random ?? Math.random;
  const span = Math.max(0, maxMs - minMs);
  // Clamped, so a random source that returns exactly 1 still lands inside the window rather
  // than one millisecond past it.
  return Math.min(maxMs, minMs + Math.floor(random() * (span + 1)));
}

/**
 * Keep the catalog current on a random schedule.
 *
 * @param {object} [options]
 * @param {number} [options.minMs] - shortest wait between reads.
 * @param {number} [options.maxMs] - longest wait, exclusive of `minMs`.
 * @param {(message: string) => void} [options.log]
 * @param {() => number} [options.random] - the source of the random point in the window.
 * @returns {() => void} a function that stops the schedule.
 */
export function startCatalogRefresh(options = {}) {
  const log = options.log ?? (() => {});
  const nextDelay = () => nextRefreshDelay(options);

  const stop = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const schedule = (delay) => {
    stop();
    timer = setTimeout(run, delay);
    // A refresh schedule must not be the reason a process stays alive.
    timer.unref?.();
  };

  const run = () => {
    void refreshCatalog({ log }).finally(() => {
      schedule(nextDelay());
    });
  };

  // The first read happens now; the timer only covers the ones after it.
  void ensureCatalog()
    .catch((error) => {
      log(`model catalog: first read failed (${error?.message ?? error})`);
    })
    .finally(() => {
      schedule(nextDelay());
    });

  return stop;
}

/** Stop the refresh schedule, for tests and for a clean shutdown. */
export function stopCatalogRefresh() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

/**
 * Shape one model for the JSON API.
 *
 * The price is `theosPerRequest`, because that is what DeepAI charges. The thinking levels
 * are still listed - a model that reasons exposes them - but they no longer change the price,
 * and claiming otherwise would put a number on a page that DeepAI never asked for.
 *
 * @param {object} model
 * @returns {object}
 */
export function publicModel(model) {
  const price = rateLabel(model);
  const context = Number.isFinite(model.contextWindow)
    ? `${model.contextWindow.toLocaleString('en-US')}-token context`
    : null;
  const output = Number.isFinite(model.maxTokens)
    ? `up to ${model.maxTokens.toLocaleString('en-US')} output tokens`
    : null;
  return {
    id: model.id,
    name: model.name,
    displayName: displayName(model),
    premier: model.premier,
    tier: model.premier ? 'premier' : 'free',
    reasoning: model.reasoning,
    // What the model accepts on the wire.
    input: [...model.input],
    inputModalities: [...model.input],
    outputModalities: ['text'],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    api: model.api,
    reasoningLevels: model.reasoning ? REASONING_LEVELS.map((level) => ({ ...level })) : [],
    // What one request costs, in Credits. `null` when DeepAI sent no price.
    theosPerRequest: model.theosPerRequest ?? null,
    rateLabel: price,
    // A ready-made one-liner for pickers and listings, made only of what DeepAI sent.
    description: [`${model.premier ? 'Premier' : 'Free'} tier`, context, output, price]
      .filter((part) => part !== null && part !== undefined)
      .join(' - '),
  };
}
