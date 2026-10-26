/**
 * Shared wire helpers for the DeepAI Code upstream.
 *
 * Both upstream transports speak the same OpenAI-compatible dialect on the
 * desktop lane (`X-DeepAI-Code-Theos`), share session-affinity headers and
 * server-sent-events framing, and reduce to one normalized event stream.
 *
 * @module deepai-gateway/deepai/wire
 */

export const API_ORIGIN = 'https://api.deepai.org';

/** Header the desktop app uses to mark `/deepai_code` traffic. */
export const LANE_HEADERS = Object.freeze({ 'X-DeepAI-Code-Theos': '1' });

/**
 * Product identity sent upstream.
 *
 * A plain `product/version` token: this gateway is its own project, so it does
 * not claim the harness repository as its home.
 */
export const USER_AGENT = 'deepai-gateway/1.0';

/** Upstream failure with a stable code. */
export class UpstreamError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.code = code;
    if (Number.isInteger(extra.status)) this.status = extra.status;
    if (Number.isFinite(extra.providerRetryAfterMs) && extra.providerRetryAfterMs > 0) {
      this.providerRetryAfterMs = Math.trunc(extra.providerRetryAfterMs);
    }
  }
}

/** Session-affinity headers, matching the desktop client (raw session id). */
function sessionHeaders(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return {};
  return {
    session_id: sessionId,
    'x-client-request-id': sessionId,
    'x-session-affinity': sessionId,
  };
}

/** Headers for one streaming DeepAI Code request. */
export function requestHeaders({ apiKey, sessionId, accept = 'text/event-stream' }) {
  return {
    'content-type': 'application/json',
    accept,
    'user-agent': USER_AGENT,
    ...LANE_HEADERS,
    ...sessionHeaders(sessionId),
    'Api-Key': apiKey,
  };
}

/** Headers for an unauthenticated DeepAI Code request. */
export function laneHeaders(accept = 'application/json') {
  return { accept, 'user-agent': USER_AGENT, ...LANE_HEADERS };
}

/** Convert a `Retry-After` header into milliseconds. */
function retryAfterMs(response) {
  const raw = response.headers?.get?.('retry-after');
  if (typeof raw !== 'string' || raw === '') return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

/** Read an error body into a short message. */
export async function errorMessage(response) {
  const body = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(body);
    return String(parsed?.error?.message ?? parsed?.error ?? parsed?.message ?? parsed?.status ?? '');
  } catch {
    return body.slice(0, 250).trim();
  }
}

/** Turn a non-2xx answer into a typed upstream error. */
export async function errorFor(response, label) {
  const message = await errorMessage(response);
  const detail = message === '' ? '' : `: ${message}`;
  const status = response.status;
  const after = retryAfterMs(response);

  if (status === 401 || status === 403) {
    return new UpstreamError(
      `DeepAI: sign-in required (HTTP ${status})${detail}`,
      'AUTH',
      { status, providerRetryAfterMs: after },
    );
  }
  if (status === 429 || status === 409) {
    return new UpstreamError(
      `DeepAI: rate limited or at capacity (HTTP ${status})${detail}`,
      'RATE_LIMIT',
      { status, providerRetryAfterMs: after },
    );
  }
  return new UpstreamError(`${label} HTTP ${status}${detail}`, 'PROVIDER_ERROR', {
    status,
    providerRetryAfterMs: after,
  });
}

/**
 * Index of the end of the next complete SSE event, or -1.
 *
 * `String#indexOf` is used instead of a `/\r?\n\r?\n/` regex: the regex is
 * roughly nine times slower and allocates a match object per event, which
 * shows up on a stream carrying hundreds of small deltas.
 *
 * @param {string} buffer
 * @returns {{index: number, length: number}} `index` is the start of the
 *   terminator and `length` its width, so callers can slice around it.
 */
export function findEventEnd(buffer) {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return { index: -1, length: 0 };
  if (crlf === -1 || (lf !== -1 && lf < crlf)) return { index: lf, length: 2 };
  return { index: crlf, length: 4 };
}

/**
 * Parse a server-sent-events body into JSON payloads.
 *
 * @param {Response} response
 * @param {AbortSignal} [signal]
 * @yields {any} parsed payload
 */
export async function* readEvents(response, signal) {
  const reader = response.body?.getReader?.();
  if (reader === undefined) throw new UpstreamError('DeepAI: response has no stream', 'PROVIDER_ERROR');

  /*
   * Ceiling on one unparsed event.
   *
   * The reader accumulates bytes until it sees a blank line, so a stream that never
   * terminates an event grows this buffer without limit — measured at roughly twice the
   * bytes received, because each append re-allocates the string. No real event comes close
   * to this, so exceeding it means the upstream is broken or hostile, and failing the
   * request is better than exhausting the process.
   */
  const MAX_EVENT_BYTES = 8 * 1024 * 1024;

  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let ended = false;

  const parseBlock = function* parseBlock(block) {
    const data = [];
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length === 0) return;
    const payload = data.join('\n').trim();
    if (payload === '' || payload === '[DONE]') {
      ended = true;
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    yield parsed;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_EVENT_BYTES) {
        throw new UpstreamError(
          `DeepAI stream sent ${buffer.length} bytes without ending an event`,
          'PROVIDER_ERROR',
        );
      }
      for (;;) {
        const { index, length } = findEventEnd(buffer);
        if (index === -1) break;
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + length);
        yield* parseBlock(block);
        if (ended) return;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== '') yield* parseBlock(buffer);
  } catch (error) {
    if (signal?.aborted) throw new UpstreamError('request aborted', 'ABORTED');
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError(`DeepAI stream failed: ${error?.message ?? error}`, 'TRANSPORT');
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      /* best effort */
    }
  }
}

/** Count a possible numeric field. */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/**
 * Normalize a chat-completions `usage` object. Prompt tokens include cache
 * reads and writes, so both are subtracted from the reported prompt total to
 * keep the counts disjoint.
 */
export function completionsUsage(raw) {
  if (raw === null || typeof raw !== 'object') return undefined;
  if (!Number.isFinite(raw.prompt_tokens) && !Number.isFinite(raw.completion_tokens)) return undefined;
  const prompt = count(raw.prompt_tokens);
  const completion = count(raw.completion_tokens);
  const cacheRead = count(
    raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? raw.cached_tokens,
  );
  const cacheWrite = count(raw.prompt_tokens_details?.cache_write_tokens);
  const reasoning = count(raw.completion_tokens_details?.reasoning_tokens);
  const input = Math.max(0, prompt - cacheRead - cacheWrite);
  return {
    inputTokens: input,
    outputTokens: completion,
    totalTokens: input + completion + cacheRead + cacheWrite,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: reasoning,
  };
}

/** Normalize a Responses API `usage` object. */
export function responsesUsage(raw) {
  if (raw === null || typeof raw !== 'object') return undefined;
  if (!Number.isFinite(raw.input_tokens) && !Number.isFinite(raw.output_tokens)) return undefined;
  const total = count(raw.input_tokens);
  const output = count(raw.output_tokens);
  const cacheRead = count(raw.input_tokens_details?.cached_tokens);
  const cacheWrite = count(raw.input_tokens_details?.cache_write_tokens);
  const reasoning = count(raw.output_tokens_details?.reasoning_tokens);
  const input = Math.max(0, total - cacheRead - cacheWrite);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output + cacheRead + cacheWrite,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: reasoning,
  };
}

/** Map an OpenAI finish reason onto the shared vocabulary. */
export function mapFinishReason(raw) {
  switch (raw) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    case 'stop':
    case 'end':
    case null:
    case undefined:
      return 'stop';
    default:
      return 'stop';
  }
}
