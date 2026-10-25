/**
 * Live reference prices and the "money saved" estimate.
 *
 * The gateway is free to run, but the tokens it moves are not free on the open
 * market. To show what the same traffic would have cost elsewhere, each DeepAI
 * model is mapped to its public equivalent on OpenRouter and priced with that
 * model's **currently published** per-token rates.
 *
 * Prices are fetched from `GET https://openrouter.ai/api/v1/models`, cached on
 * disk, and refreshed periodically. A bundled snapshot is used only until the
 * first successful fetch — the numbers are never the long-term source of truth.
 *
 * Cached input is billed at the model's own cache-read rate when the provider
 * publishes one, and cache writes at the cache-write rate. Only when a rate is
 * genuinely unpublished does the code fall back to the full input rate, which
 * overstates the cost rather than understating it.
 *
 * @module deepai-gateway/pricing
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Where the live catalogue lives. */
const OPENROUTER_MODELS = 'https://openrouter.ai/api/v1/models';

/** How long a fetched catalogue stays fresh. */
const DEFAULT_TTL_MS = 6 * 60 * 60_000;

/**
 * DeepAI catalog id → OpenRouter model id.
 *
 * This mapping is curated rather than inferred: the two catalogues spell the
 * same models differently (`mimo-2.6-flash` vs `xiaomi/mimo-v2.6-flash`,
 * `claude-opus-5-5` vs `anthropic/claude-opus-5.5`), and a wrong guess would
 * silently price traffic against the wrong model. `null` means the model has no
 * public equivalent, so its usage is counted but never priced.
 */
export const MODEL_SOURCES = Object.freeze({
  'glm-5.3-flash': 'z-ai/glm-5.3-flash',
  'deepseek-v4.1-flash': 'deepseek/deepseek-v4.1-flash',
  'mimo-2.6-flash': 'xiaomi/mimo-v2.6-flash',
  'solar-mini-4': 'upstage/solar-mini4',
  'gpt-6-luna': 'openai/gpt-6-luna',
  'mimo-2.6-pro': 'xiaomi/mimo-v2.6-pro',
  'deepai-cyber': null,
  'gpt-6.1-sol': 'openai/gpt-6.1-sol',
  'glm-5.3': 'z-ai/glm-5.3',
  'kimi-k3': 'moonshotai/kimi-k3',
  'claude-opus-5-5': 'anthropic/claude-opus-5.5',
  'claude-fable-5-1': 'anthropic/claude-fable-5.1',
  'gpt-6-astra': 'openai/gpt-6-astra',
});

/**
 * Bundled snapshot, in USD per million tokens.
 *
 * Used only until the first live fetch succeeds. `cacheRead` and `cacheWrite`
 * are `null` when the provider publishes no separate rate.
 */
export const FALLBACK_PRICES = Object.freeze({
  'glm-5.3-flash': { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: null },
  'deepseek-v4.1-flash': { input: 0.02, output: 1.0, cacheRead: 0.015, cacheWrite: null },
  'mimo-2.6-flash': { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: null },
  'solar-mini-4': { input: 0.05, output: 0.2, cacheRead: 0.005, cacheWrite: null },
  'gpt-6-luna': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'mimo-2.6-pro': { input: 0.435, output: 0.87, cacheRead: 0.0036, cacheWrite: null },
  'gpt-6.1-sol': { input: 2.0, output: 10.0, cacheRead: 0.1, cacheWrite: 2.5 },
  'glm-5.3': { input: 0.079, output: 1.4, cacheRead: 0.078, cacheWrite: null },
  'kimi-k3': { input: 0.239, output: 10.8, cacheRead: 0.21, cacheWrite: null },
  'claude-opus-5-5': { input: 4.0, output: 20.0, cacheRead: 0.2, cacheWrite: 5.0 },
  'claude-fable-5-1': { input: 10.0, output: 50.0, cacheRead: 0.25, cacheWrite: 12.5 },
  'gpt-6-astra': { input: 10.0, output: 50.0, cacheRead: 1.0, cacheWrite: 12.5 },
  'deepai-cyber': null,
});

/** When the bundled snapshot was captured. */
export const FALLBACK_CAPTURED_AT = '2026-10-25';

/* ------------------------------------------------------------------- state */

const state = {
  prices: FALLBACK_PRICES,
  capturedAt: FALLBACK_CAPTURED_AT,
  source: 'bundled',
  fetchedAt: 0,
  ttlMs: DEFAULT_TTL_MS,
  cachePath: undefined,
  refreshing: undefined,
  lastError: undefined,
  log: () => {},
};

/* ------------------------------------------------------------------ parsing */

/**
 * Parse a USD-per-token value into USD per million tokens.
 *
 * The result is rounded to six decimals: multiplying a decimal string like
 * `0.0000002` by a million yields `0.19999999999999998`, which would otherwise
 * leak into the API and the dashboard.
 */
function perMillion(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(number * 1_000_000 * 1e6) / 1e6;
}

/** Shape one OpenRouter entry into a price record. */
export function parsePrice(entry) {
  const pricing = entry?.pricing;
  if (pricing === null || typeof pricing !== 'object') return null;
  const input = perMillion(pricing.prompt);
  const output = perMillion(pricing.completion);
  if (input === null && output === null) return null;
  return {
    input: input ?? 0,
    output: output ?? 0,
    // Kept as null when unpublished, so the fallback to the input rate is an
    // explicit decision at pricing time rather than a silent zero.
    cacheRead: perMillion(pricing.input_cache_read),
    cacheWrite: perMillion(pricing.input_cache_write),
    contextLength: Number.isSafeInteger(entry?.context_length) ? entry.context_length : null,
    name: typeof entry?.name === 'string' ? entry.name : undefined,
  };
}

/**
 * Build the DeepAI-keyed price table from an OpenRouter catalogue.
 *
 * @param {Array<object>} entries
 * @returns {{prices: object, matched: string[], missing: string[]}}
 */
export function buildPrices(entries) {
  const byId = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string') continue;
    // Batch and alias variants are cheaper or indirect; never use them.
    if (entry.id.includes(':') || entry.id.startsWith('~')) continue;
    byId.set(entry.id, entry);
  }

  const prices = {};
  const matched = [];
  const missing = [];
  for (const [deepaiId, sourceId] of Object.entries(MODEL_SOURCES)) {
    if (sourceId === null) {
      prices[deepaiId] = null;
      continue;
    }
    const parsed = parsePrice(byId.get(sourceId));
    if (parsed === null) {
      missing.push(deepaiId);
      continue;
    }
    prices[deepaiId] = { ...parsed, source: sourceId };
    matched.push(deepaiId);
  }
  return { prices, matched, missing };
}

/* ------------------------------------------------------------------- cache */

/** Read a cached catalogue from disk, if it parses. */
export function readCache(cachePath) {
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return undefined;
    if (typeof parsed.capturedAt !== 'string' || parsed.prices === null || typeof parsed.prices !== 'object') {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/** Write the catalogue atomically. */
function writeCache(cachePath, payload) {
  mkdirSync(dirname(cachePath), { recursive: true });
  const temporary = `${cachePath}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(temporary, cachePath);
}

/* --------------------------------------------------------------------- init */

/**
 * Load the disk cache and configure the module. Safe to call once at boot.
 *
 * @param {object} options
 * @param {string} [options.cachePath] - where the live catalogue is cached.
 * @param {number} [options.ttlMs]
 * @param {(message: string) => void} [options.log]
 */
export function initPricing(options = {}) {
  if (typeof options.cachePath === 'string') state.cachePath = options.cachePath;
  if (Number.isFinite(options.ttlMs) && options.ttlMs > 0) state.ttlMs = options.ttlMs;
  if (typeof options.log === 'function') state.log = options.log;

  if (state.cachePath !== undefined) {
    const cached = readCache(state.cachePath);
    if (cached !== undefined) {
      state.prices = cached.prices;
      state.capturedAt = cached.capturedAt;
      state.fetchedAt = Number(cached.fetchedAt) || Date.parse(cached.capturedAt) || 0;
      state.source = 'cache';
      state.log(`pricing: loaded ${Object.keys(cached.prices).length} entries from cache (${cached.capturedAt})`);
    }
  }
  return pricingStatus();
}

/**
 * Fetch live prices and replace the table. Rejects only when nothing usable is
 * available; a partial answer still updates the models it covers.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ok: boolean, source: string, capturedAt: string, matched: string[], missing: string[], error?: string}>}
 */
export async function refreshPrices(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = options.signal ?? AbortSignal.timeout(20_000);
  const now = new Date();

  try {
    const response = await fetchImpl(OPENROUTER_MODELS, { headers: { accept: 'application/json' }, signal });
    if (!response.ok) throw new Error(`OpenRouter models: HTTP ${response.status}`);
    const payload = await response.json();
    const entries = Array.isArray(payload?.data) ? payload.data : [];
    if (entries.length === 0) throw new Error('OpenRouter models: empty answer');

    const { prices, matched, missing } = buildPrices(entries);
    if (matched.length === 0) throw new Error('OpenRouter models: no reference model matched');

    // Keep the previous value for anything the live answer did not cover, so a
    // renamed upstream id degrades one model instead of the whole table.
    for (const id of missing) {
      if (state.prices[id] !== undefined && state.prices[id] !== null) prices[id] = state.prices[id];
    }

    const capturedAt = now.toISOString();
    state.prices = prices;
    state.capturedAt = capturedAt;
    state.fetchedAt = now.getTime();
    state.source = 'live';
    state.lastError = undefined;

    if (state.cachePath !== undefined) {
      try {
        writeCache(state.cachePath, { capturedAt, fetchedAt: state.fetchedAt, prices });
      } catch (error) {
        state.log(`pricing: could not write the cache: ${error?.message ?? error}`);
      }
    }
    state.log(`pricing: refreshed ${matched.length} models from OpenRouter`);
    return { ok: true, source: 'live', capturedAt, matched, missing };
  } catch (error) {
    state.lastError = String(error?.message ?? error);
    state.log(`pricing: refresh failed (${state.lastError}); keeping ${state.source} prices`);
    return {
      ok: false,
      source: state.source,
      capturedAt: state.capturedAt,
      matched: [],
      missing: Object.keys(MODEL_SOURCES),
      error: state.lastError,
    };
  }
}

/**
 * Refresh only when the table is older than the TTL, and never twice at once.
 * Callers can fire and forget.
 */
export function refreshPricesIfStale(options = {}) {
  if (state.refreshing !== undefined) return state.refreshing;
  if (state.fetchedAt !== 0 && Date.now() - state.fetchedAt < state.ttlMs) {
    return Promise.resolve({ ok: true, source: state.source, capturedAt: state.capturedAt, matched: [], missing: [] });
  }
  state.refreshing = refreshPrices(options).finally(() => {
    state.refreshing = undefined;
  });
  return state.refreshing;
}

/** Start a periodic refresh. Returns a stop function. */
export function startPricingRefresh(options = {}) {
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : state.ttlMs;
  void refreshPricesIfStale(options);
  const timer = setInterval(() => void refreshPricesIfStale(options), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Current pricing status, for the dashboard and diagnostics. */
export function pricingStatus() {
  const ageMs = state.fetchedAt === 0 ? null : Date.now() - state.fetchedAt;
  return {
    source: state.source,
    capturedAt: state.capturedAt,
    fetchedAt: state.fetchedAt === 0 ? null : state.fetchedAt,
    ageMs,
    stale: ageMs === null ? true : ageMs > state.ttlMs,
    ttlMs: state.ttlMs,
    models: Object.keys(MODEL_SOURCES).length,
    priced: Object.values(state.prices).filter((entry) => entry !== null && entry !== undefined).length,
    lastError: state.lastError,
  };
}

/** The price record for one DeepAI model, or `null` when unpriced. */
export function priceOf(model) {
  return state.prices[model] ?? null;
}

/** Whether a model can be priced. */
export function isPriced(model) {
  return priceOf(model) !== null;
}

/** The whole table, as DeepAI ids. */
export function priceTable() {
  return state.prices;
}

/* ------------------------------------------------------------------ pricing */

/**
 * Cost of one usage row in USD, split by token class.
 *
 * Each class is billed at its own published rate:
 * - `inputTokens` → `input`
 * - `cacheReadTokens` → `cacheRead`, falling back to `input`
 * - `cacheWriteTokens` → `cacheWrite`, falling back to `input`
 * - `outputTokens` → `output`
 *
 * The fallback deliberately overstates the cost, because a missing cache rate
 * means the provider charges its normal input rate for those tokens.
 *
 * @param {string} model
 * @param {{inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number}} usage
 * @returns {{usd: number, inputUsd: number, cacheReadUsd: number, cacheWriteUsd: number, outputUsd: number, source: string|null}|undefined}
 */
export function priceUsage(model, usage) {
  const price = priceOf(model);
  if (price === null) return undefined;

  const M = 1_000_000;
  const inputTokens = Number(usage?.inputTokens ?? 0);
  const outputTokens = Number(usage?.outputTokens ?? 0);
  const cacheReadTokens = Number(usage?.cacheReadTokens ?? 0);
  const cacheWriteTokens = Number(usage?.cacheWriteTokens ?? 0);

  const inputRate = price.input;
  const readRate = price.cacheRead ?? inputRate;
  const writeRate = price.cacheWrite ?? inputRate;

  const inputUsd = (inputTokens / M) * inputRate;
  const cacheReadUsd = (cacheReadTokens / M) * readRate;
  const cacheWriteUsd = (cacheWriteTokens / M) * writeRate;
  const outputUsd = (outputTokens / M) * price.output;

  return {
    usd: inputUsd + cacheReadUsd + cacheWriteUsd + outputUsd,
    inputUsd,
    cacheReadUsd,
    cacheWriteUsd,
    outputUsd,
    source: price.source ?? null,
  };
}

/**
 * Total estimated cost of a per-model usage breakdown.
 *
 * @param {Array<object>} models
 * @returns {{usd: number, pricedTokens: number, unpricedTokens: number, unpricedModels: string[], perModel: Array<object>}}
 */
export function estimateSavings(models) {
  let usd = 0;
  let pricedTokens = 0;
  let unpricedTokens = 0;
  const unpricedModels = [];
  const perModel = [];

  for (const entry of models) {
    const tokens = Number(entry.totalTokens ?? 0);
    const priced = priceUsage(entry.model, entry);
    if (priced === undefined) {
      unpricedTokens += tokens;
      if (tokens > 0) unpricedModels.push(entry.model);
      perModel.push({ model: entry.model, tokens, usd: null, priced: false });
      continue;
    }
    usd += priced.usd;
    pricedTokens += tokens;
    perModel.push({
      model: entry.model,
      tokens,
      usd: priced.usd,
      priced: true,
      source: priced.source,
      inputUsd: priced.inputUsd,
      cacheReadUsd: priced.cacheReadUsd,
      cacheWriteUsd: priced.cacheWriteUsd,
      outputUsd: priced.outputUsd,
    });
  }

  perModel.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
  return { usd, pricedTokens, unpricedTokens, unpricedModels, perModel };
}

/** Format USD for display. Small amounts keep enough precision to be useful. */
export function formatUsd(value) {
  const amount = Number(value) || 0;
  if (amount === 0) return '$0.00';
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  if (amount < 1) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(2)}`;
}

/** The reference table as a public list, for the dashboard. */
export function publicPrices() {
  const status = pricingStatus();
  return Object.entries(MODEL_SOURCES).map(([model, sourceId]) => {
    const price = priceOf(model);
    return {
      model,
      source: sourceId,
      priced: price !== null,
      inputPerMillion: price?.input ?? null,
      outputPerMillion: price?.output ?? null,
      cacheReadPerMillion: price?.cacheRead ?? null,
      cacheWritePerMillion: price?.cacheWrite ?? null,
      contextLength: price?.contextLength ?? null,
      priceSource: price?.source ?? null,
      asOf: status.capturedAt,
      live: status.source === 'live',
    };
  });
}

/** Reset to the bundled snapshot. Test-only. */
export function resetPricing() {
  state.prices = FALLBACK_PRICES;
  state.capturedAt = FALLBACK_CAPTURED_AT;
  state.source = 'bundled';
  state.fetchedAt = 0;
  state.refreshing = undefined;
  state.lastError = undefined;
}
