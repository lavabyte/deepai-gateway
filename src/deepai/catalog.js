/**
 * DeepAI Code model catalog.
 *
 * `GET /deepai_code/models` is readable without an account and is the single
 * source of truth for which models exist, what they cost and which upstream
 * API they use. The live answer is cached and an embedded snapshot keeps the
 * gateway usable when the network is down.
 *
 * @module deepai-gateway/deepai/catalog
 */

import { API_ORIGIN, LANE_HEADERS } from './wire.js';

/** How long a successful catalog answer is reused. */
const CACHE_TTL_MS = 10 * 60_000;

/** Thinking levels DeepAI publishes rates for, cheapest-per-second last. */
const LEVELS = ['none', 'low', 'medium', 'high'];

/** Human labels for the thinking levels, in the order the API exposes them. */
export const REASONING_LEVELS = Object.freeze([
  { id: 'none', name: 'None', description: 'Answer without extended thinking.' },
  { id: 'low', name: 'Low', description: 'Short reasoning pass.' },
  { id: 'medium', name: 'Medium', description: 'Balanced reasoning depth.' },
  { id: 'high', name: 'High', description: 'Deepest reasoning, slowest per token but cheapest per second.' },
]);

/** Embedded snapshot (13 models) used before the first fetch and offline. */
export const FALLBACK_MODELS = Object.freeze([
  entry('glm-5.3-flash', 'GLM 5.3 Flash', { image: true, contextWindow: 1048576, maxTokens: 131072 }),
  entry('deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', { image: true, contextWindow: 1048576, maxTokens: 131072 }),
  entry('mimo-2.6-flash', 'MiMo 2.6 Flash', { image: true, contextWindow: 1048576, maxTokens: 131072 }),
  entry('solar-mini-4', 'Solar Mini 4', { contextWindow: 524288, maxTokens: 131072 }),
  entry('gpt-6-luna', 'GPT-6 Luna', { image: true, contextWindow: 1048576, maxTokens: 128000 }),
  entry('mimo-2.6-pro', 'MiMo 2.6 Pro', { image: true, contextWindow: 1048576, maxTokens: 131072 }),
  entry('deepai-cyber', 'DeepAI Cyber', { contextWindow: 65536, maxTokens: 8192 }),
  entry('gpt-6.1-sol', 'GPT-6.1 Sol', { image: true, premier: true, contextWindow: 1048576, maxTokens: 128000, rates: [0.05, 0.04, 0.025, 0.015] }),
  entry('glm-5.3', 'GLM 5.3', { premier: true, contextWindow: 1048576, maxTokens: 131072, rates: [0.1, 0.06, 0.03, 0.02] }),
  entry('kimi-k3', 'Kimi K3', { image: true, premier: true, contextWindow: 1048576, maxTokens: 131072, rates: [0.12, 0.1, 0.05, 0.03] }),
  entry('claude-opus-5-5', 'Claude Opus 5.5', { image: true, premier: true, contextWindow: 1000000, maxTokens: 64000, rates: [0.15, 0.12, 0.08, 0.06] }),
  entry('claude-fable-5-1', 'Claude Fable 5.1', { image: true, premier: true, contextWindow: 1000000, maxTokens: 64000, rates: [0.25, 0.2, 0.12, 0.1] }),
  entry('gpt-6-astra', 'GPT-6 Astra', { image: true, premier: true, contextWindow: 1048576, maxTokens: 128000, api: 'openai-responses', rates: [0.3, 0.2, 0.12, 0.1] }),
]);

function entry(id, name, options = {}) {
  const rates = {};
  for (const [index, level] of LEVELS.entries()) {
    rates[level] = String(options.rates?.[index] ?? 0);
  }
  return Object.freeze({
    id,
    name,
    reasoning: true,
    input: Object.freeze(options.image === true ? ['text', 'image'] : ['text']),
    contextWindow: options.contextWindow ?? 131072,
    maxTokens: options.maxTokens ?? 32768,
    premier: options.premier === true,
    api: options.api ?? 'openai-completions',
    creditsPerSecond: Object.freeze(rates),
  });
}

/**
 * Label shown wherever a model is named. Models the free tier can use are
 * marked so the tier is visible without opening the description.
 */
export function displayName(model) {
  return model.premier === false ? `${model.name} Free` : model.name;
}

/** Credits per minute at one thinking level, or `Unmetered` when free. */
export function rateLabel(model, level = 'none') {
  const raw = model.creditsPerSecond?.[level] ?? model.creditsPerSecond?.none;
  const value = Number(raw);
  if (!Number.isFinite(value)) return 'Unknown';
  if (value === 0) return 'Unmetered';
  return `${Math.round(value * 600) / 10} Credits/min`;
}

/** Last successfully loaded catalog, if any. */
let cached;
let cachedAt = 0;
let pending;

/** The catalog we can serve right now. */
export function catalogSnapshot() {
  return cached ?? FALLBACK_MODELS;
}

/** Look one model up in the catalog we can serve right now. */
export function findModel(id) {
  return catalogSnapshot().find((model) => model.id === id);
}

/** Shape one provider payload entry into a catalog record. */
function normalize(raw, fallback) {
  if (raw === null || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id === '') return undefined;
  const input = Array.isArray(raw.input)
    ? raw.input.filter((item) => item === 'text' || item === 'image')
    : [];
  const rates = {};
  for (const level of LEVELS) {
    const value = raw.creditsPerSecond?.[level];
    rates[level] = typeof value === 'string' ? value : (fallback?.creditsPerSecond?.[level] ?? '0');
  }
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : raw.id,
    reasoning: raw.reasoning === true,
    input: input.length > 0 ? input : ['text'],
    contextWindow: Number.isSafeInteger(raw.contextWindow) && raw.contextWindow > 0
      ? raw.contextWindow
      : (fallback?.contextWindow ?? 131072),
    maxTokens: Number.isSafeInteger(raw.maxTokens) && raw.maxTokens > 0
      ? raw.maxTokens
      : (fallback?.maxTokens ?? 32768),
    premier: raw.premier === true,
    api: typeof raw.api === 'string' && raw.api !== '' ? raw.api : 'openai-completions',
    creditsPerSecond: rates,
  };
}

/** Fetch the live catalog; rejects on any transport or shape problem. */
export async function fetchCatalog(signal) {
  const response = await fetch(`${API_ORIGIN}/deepai_code/models`, {
    headers: { ...LANE_HEADERS, accept: 'application/json' },
    signal,
  });
  if (!response.ok) throw new Error(`DeepAI model catalog: HTTP ${response.status}`);
  const data = await response.json();
  const list = Array.isArray(data?.models) ? data.models : [];
  const models = [];
  const seen = new Set();
  for (const raw of list) {
    const model = normalize(raw, findModel(raw?.id));
    if (model === undefined || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  if (models.length === 0) throw new Error('DeepAI model catalog: empty answer');
  return models;
}

/** The catalog to advertise; a failed fetch falls back to the snapshot. */
export async function loadCatalog(signal) {
  if (cached !== undefined && Date.now() - cachedAt < CACHE_TTL_MS) return cached;
  if (pending !== undefined) return pending;
  pending = (async () => {
    try {
      const models = await fetchCatalog(signal ?? AbortSignal.timeout(10_000));
      cached = models;
      cachedAt = Date.now();
      return models;
    } catch {
      return catalogSnapshot();
    } finally {
      pending = undefined;
    }
  })();
  return pending;
}

/** Warm the cache without waiting for it. */
export function prefetchCatalog() {
  void loadCatalog().catch(() => {});
}

/** Shape one model for the JSON API. */
export function publicModel(model) {
  const rates = { ...model.creditsPerSecond };
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
    // Thinking levels, with the per-level rate so a client can price a call.
    reasoningLevels: model.reasoning
      ? REASONING_LEVELS.map((level) => ({
          ...level,
          creditsPerSecond: rates[level.id] ?? '0',
          rateLabel: rateLabel(model, level.id),
        }))
      : [],
    creditsPerSecond: rates,
    rateLabel: rateLabel(model, 'none'),
    // A ready-made one-liner for pickers and listings.
    description: `${model.premier ? 'Premier' : 'Free'} tier - ${model.contextWindow.toLocaleString('en-US')}-token context - up to ${model.maxTokens.toLocaleString('en-US')} output tokens`,
  };
}
