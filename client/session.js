/**
 * Client-owned sessions for OpenAI-compatible code-tool clients.
 *
 * A session lives entirely in the caller: it owns the transcript, the id and any branch.
 * Every completion carries the whole transcript, `x-gateway-history: off` and the session id
 * for DeepAI prompt affinity. The default transport uses the ordinary chat route; the
 * `sessions` transport uses the stateless session route. The gateway forwards the request
 * and keeps no copy either way.
 *
 * The module uses only `fetch`, `crypto.randomUUID` and `structuredClone`, so it runs in
 * Node and in a browser without a build step.
 *
 * @module deepai-gateway/client/session
 */

const DEFAULT_MODEL = 'glm-5.3-flash';
const TRANSPORTS = new Set(['chat', 'sessions']);

/** A gateway refusal, with the HTTP status and the gateway's error code. */
export class GatewayError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, code?: string, body?: unknown}} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'GatewayError';
    this.status = details.status ?? 0;
    this.code = details.code ?? 'gateway_error';
    this.body = details.body;
  }
}

function clone(value) {
  return structuredClone(value);
}

function newId() {
  if (globalThis.crypto?.randomUUID !== undefined) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues !== undefined) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-`
    + `${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function chatUrl(session) {
  const base = session.baseUrl.replace(/\/+$/, '');
  if (base.endsWith('/chat/completions') || base.endsWith('/messages')) return base;
  if (session.transport === 'sessions') {
    return `${base}/sessions/${encodeURIComponent(session.id)}/messages`;
  }
  return `${base}/chat/completions`;
}

function normalizeMessage(message) {
  if (typeof message === 'string') return { role: 'user', content: message };
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    throw new TypeError('A message must be a string or an object with a role.');
  }
  if (typeof message.role !== 'string' || message.role === '') {
    throw new TypeError('A message object needs a non-empty role.');
  }
  return clone(message);
}

function normalizeMessages(message) {
  const list = Array.isArray(message) ? message : [message];
  if (list.length === 0) throw new TypeError('At least one message is required.');
  return list.map(normalizeMessage);
}

function assertSession(session) {
  if (session === null || typeof session !== 'object' || !Array.isArray(session.messages)) {
    throw new TypeError('Expected a session from createSession().');
  }
}

function assertOpen(session) {
  assertSession(session);
  if (session.closed === true) {
    throw new GatewayError('This session is closed.', { code: 'session_closed' });
  }
}

function requestBody(session, messages, stream, options) {
  const params = { ...session.params, ...(options.params ?? {}) };
  return {
    ...params,
    model: options.model ?? session.model,
    messages,
    stream,
  };
}

async function post(session, body, options) {
  const fetchImpl = options.fetch ?? session.fetch;
  const response = await fetchImpl(chatUrl(session), {
    method: 'POST',
    headers: {
      ...session.headers,
      ...(options.headers ?? {}),
      authorization: `Bearer ${session.apiKey}`,
      'content-type': 'application/json',
      'x-session-id': session.id,
      'x-gateway-history': 'off',
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!response.ok) throw await errorFromResponse(response);
  return response;
}

async function errorFromResponse(response) {
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (body === undefined) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (raw === '' || raw === '[DONE]') continue;
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.error !== undefined) {
          body = parsed;
          break;
        }
      } catch {
        /* not an SSE error; fall through to the HTTP text */
      }
    }
  }
  const detail = body?.error ?? body;
  const message = typeof detail?.message === 'string'
    ? detail.message
    : `The gateway answered HTTP ${response.status}.`;
  return new GatewayError(message, {
    status: response.status,
    code: detail?.code ?? 'gateway_error',
    body: body ?? text,
  });
}

/**
 * Create a session locally. No request is made.
 *
 * @param {object} config
 * @param {string} config.baseUrl - gateway base, usually `http://host:8080/v1`
 * @param {string} config.apiKey - gateway API key
 * @param {string} [config.model] - model id, default `glm-5.3-flash`
 * @param {string} [config.id] - caller-chosen session id; a UUID is generated otherwise
 * @param {'chat'|'sessions'} [config.transport] - standard chat route (default) or session route
 * @param {Array<object>} [config.messages] - an existing transcript to continue
 * @param {string|Array<object>} [config.system] - system prompt, prepended
 * @param {object} [config.params] - extra completion fields (temperature, tools, ...)
 * @param {object} [config.tools] - shortcut for `params.tools`
 * @param {Record<string,string>} [config.headers] - extra gateway headers
 * @param {typeof fetch} [config.fetch] - injection point for tests or another runtime
 * @returns {object}
 */
export function createSession(config = {}) {
  const baseUrl = requireString(config.baseUrl, 'baseUrl');
  const apiKey = requireString(config.apiKey, 'apiKey');
  const model = requireString(config.model ?? DEFAULT_MODEL, 'model');
  const id = requireString(config.id ?? newId(), 'id');
  const transport = config.transport ?? 'chat';
  if (!TRANSPORTS.has(transport)) {
    throw new TypeError("transport must be 'chat' or 'sessions'.");
  }
  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetch is not available; pass config.fetch explicitly.');
  }

  let messages = config.messages === undefined ? [] : clone(config.messages);
  if (!Array.isArray(messages)) throw new TypeError('messages must be an array.');
  if (config.system !== undefined) {
    const system = typeof config.system === 'string'
      ? [{ role: 'system', content: config.system }]
      : normalizeMessages(config.system);
    messages = [...system, ...messages];
  }

  const params = { ...(config.params ?? {}) };
  if (config.tools !== undefined) params.tools = clone(config.tools);

  const session = {
    id,
    baseUrl,
    apiKey,
    model,
    transport,
    messages,
    params,
    headers: { ...(config.headers ?? {}) },
    fetch: fetchImpl,
    closed: false,
  };

  // The same mechanics are available as methods, so a client can hold one object.
  session.sendMessage = (message, options) => sendMessage(session, message, options);
  session.sendMessageStream = (message, options) => sendMessageStream(session, message, options);
  session.fork = (overrides) => forkSession(session, overrides);
  session.close = () => closeSession(session);
  return session;
}

/**
 * Branch a session locally. The transcript is copied, not shared.
 *
 * @param {object} session
 * @param {object} [overrides] - same fields as createSession, plus `messages`
 * @returns {object}
 */
export function forkSession(session, overrides = {}) {
  assertOpen(session);
  const { system, ...rest } = overrides;
  const messages = rest.messages === undefined
    ? clone(session.messages)
    : clone(rest.messages);
  const forked = createSession({
    ...session,
    ...rest,
    id: rest.id ?? newId(),
    messages,
  });
  if (system !== undefined) {
    const leading = typeof system === 'string'
      ? [{ role: 'system', content: system }]
      : normalizeMessages(system);
    forked.messages = [
      ...leading,
      ...forked.messages.filter((message) => message.role !== 'system'),
    ];
  }
  return forked;
}

/**
 * Close a session locally. There is nothing on the gateway to delete.
 *
 * @param {object} session
 * @returns {object} the same session, marked closed and with its transcript released
 */
export function closeSession(session) {
  assertSession(session);
  session.closed = true;
  session.messages.length = 0;
  return session;
}

/**
 * Send one message (or several) and append the answer to the transcript.
 *
 * The request carries the complete transcript. On failure the session is unchanged, so
 * the caller can retry the same message.
 *
 * @param {object} session
 * @param {string|object|Array<string|object>} message
 * @param {object} [options]
 * @param {object} [options.params] - per-call completion fields
 * @param {string} [options.model] - per-call model override
 * @param {AbortSignal} [options.signal]
 * @param {Record<string,string>} [options.headers]
 * @param {typeof fetch} [options.fetch]
 * @returns {Promise<{message: object, usage?: object, context?: object, raw: object}>}
 */
export async function sendMessage(session, message, options = {}) {
  assertOpen(session);
  if (options.stream === true) {
    throw new TypeError('sendMessage does not stream; use sendMessageStream().');
  }
  const added = normalizeMessages(message);
  const body = requestBody(session, [...session.messages, ...added], false, options);
  const response = await post(session, body, options);
  const data = await response.json();
  const assistant = data?.choices?.[0]?.message;
  if (assistant === null || typeof assistant !== 'object') {
    throw new GatewayError('The gateway returned no assistant message.', {
      status: response.status,
      code: 'invalid_response',
      body: data,
    });
  }
  const stored = clone(assistant);
  session.messages.push(...added, stored);
  return { message: stored, usage: data.usage, context: data.context, raw: data };
}

/**
 * Stream one message and append the completed answer to the transcript.
 *
 * Yields `{type: 'delta', text}`, `{type: 'reasoning', text}`, optionally
 * `{type: 'usage', usage, context}`, and finally
 * `{type: 'done', message, usage, context, finishReason}`. A consumer that stops early
 * leaves the session unchanged.
 *
 * @param {object} session
 * @param {string|object|Array<string|object>} message
 * @param {object} [options] - same as sendMessage
 * @returns {AsyncGenerator<object>}
 */
export async function* sendMessageStream(session, message, options = {}) {
  assertOpen(session);
  const added = normalizeMessages(message);
  const body = requestBody(session, [...session.messages, ...added], true, options);
  const response = await post(session, body, options);
  if (response.body === null) {
    throw new GatewayError('The gateway returned no stream body.', {
      status: response.status,
      code: 'invalid_response',
    });
  }

  const content = [];
  const reasoning = [];
  const calls = new Map();
  let usage;
  let context;
  let finishReason = 'stop';
  let sawDone = false;
  let sawFinish = false;

  for await (const raw of sseEvents(response.body)) {
    if (raw === '[DONE]') {
      sawDone = true;
      break;
    }
    let chunk;
    try {
      chunk = JSON.parse(raw);
    } catch {
      throw new GatewayError('The gateway sent a malformed stream event.', {
        status: response.status,
        code: 'invalid_stream',
        body: raw,
      });
    }
    if (chunk?.error !== undefined) {
      throw new GatewayError(
        typeof chunk.error.message === 'string' ? chunk.error.message : 'The gateway stream failed.',
        { status: response.status, code: chunk.error.code ?? 'upstream_error', body: chunk },
      );
    }
    if (chunk?.usage !== undefined) usage = chunk.usage;
    if (chunk?.context !== undefined) context = chunk.context;
    const choice = chunk?.choices?.[0];
    if (choice === undefined) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string' && delta.content !== '') {
      content.push(delta.content);
      yield { type: 'delta', text: delta.content };
    }
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
      reasoning.push(delta.reasoning_content);
      yield { type: 'reasoning', text: delta.reasoning_content };
    }
    for (const part of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const index = Number.isInteger(part.index) ? part.index : calls.size;
      let call = calls.get(index);
      if (call === undefined) {
        call = { id: '', type: 'function', function: { name: '', arguments: '' } };
        calls.set(index, call);
      }
      if (typeof part.id === 'string' && part.id !== '') call.id = part.id;
      if (typeof part.type === 'string' && part.type !== '') call.type = part.type;
      if (typeof part.function?.name === 'string') call.function.name += part.function.name;
      if (typeof part.function?.arguments === 'string') {
        call.function.arguments += part.function.arguments;
      }
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') {
      finishReason = choice.finish_reason;
      sawFinish = true;
    }
  }

  if (!sawDone && !sawFinish) {
    throw new GatewayError('The gateway stream ended before the answer was complete.', {
      status: response.status,
      code: 'incomplete_stream',
    });
  }

  const toolCalls = [...calls.values()]
    .filter((call) => call.function.name !== '')
    .map((call) => ({
      ...call,
      function: {
        ...call.function,
        arguments: call.function.arguments === '' ? '{}' : call.function.arguments,
      },
    }));
  const assistant = {
    role: 'assistant',
    content: content.length === 0 ? null : content.join(''),
    ...(reasoning.length === 0 ? {} : { reasoning_content: reasoning.join('') }),
    ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
  };
  session.messages.push(...added, assistant);
  if (usage !== undefined || context !== undefined) yield { type: 'usage', usage, context };
  yield { type: 'done', message: assistant, usage, context, finishReason };
}

function nextBoundary(buffer) {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return undefined;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function eventData(raw) {
  const data = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    data.push(line.slice(5).replace(/^ /, ''));
  }
  return data.length === 0 ? undefined : data.join('\n');
}

async function* sseEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        finished = true;
        break;
      }
      buffer += decoder.decode(next.value, { stream: true });
      let boundary;
      while ((boundary = nextBoundary(buffer)) !== undefined) {
        const raw = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const data = eventData(raw);
        if (data !== undefined) yield data;
      }
    }
    buffer += decoder.decode();
    const tail = eventData(buffer);
    if (tail !== undefined) yield tail;
  } finally {
    if (!finished) {
      try {
        await reader.cancel();
      } catch {
        /* the stream is already gone */
      }
    }
    reader.releaseLock();
  }
}