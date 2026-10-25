/**
 * Upstream DeepAI Code client.
 *
 * Two transports, one normalized event stream:
 *
 * - `streamChatCompletion` — `POST /deepai_code/chat/completions`, the OpenAI
 *   dialect the desktop app uses for most models;
 * - `streamResponsesCompletion` — `POST /deepai_code/responses`, used by models
 *   that declare `api: "openai-responses"`.
 *
 * Both yield `{type}` events: `text`, `reasoning`, `tool-start`,
 * `tool-arguments`, `usage`, `finish`.
 *
 * @module deepai-gateway/deepai/client
 */

import { openAIToResponsesInput, openAIToResponsesTools } from '../openai.js';
import {
  API_ORIGIN,
  UpstreamError,
  completionsUsage,
  errorFor,
  mapFinishReason,
  readEvents,
  requestHeaders,
  responsesUsage,
} from './wire.js';

/** First non-empty reasoning field of one delta. */
function reasoningOf(delta) {
  for (const field of ['reasoning_content', 'reasoning', 'reasoning_text']) {
    const value = delta?.[field];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

/**
 * One streamed chat completion.
 *
 * @param {object} params
 * @param {string} params.apiKey
 * @param {string} params.model
 * @param {Array<object>} params.messages - OpenAI messages.
 * @param {Array<object>} [params.tools]
 * @param {number} [params.maxTokens]
 * @param {number} [params.temperature]
 * @param {number} [params.topP]
 * @param {string[]} [params.stop]
 * @param {string} [params.reasoningEffort]
 * @param {string} [params.sessionId]
 * @param {AbortSignal} [params.signal]
 * @yields {{type: string}}
 */
export async function* streamChatCompletion(params) {
  const body = {
    model: params.model,
    messages: params.messages,
    stream: true,
    stream_options: { include_usage: true },
    store: false,
  };
  if (Array.isArray(params.tools) && params.tools.length > 0) {
    body.tools = params.tools;
    body.tool_choice = 'auto';
  }
  if (Number.isFinite(params.maxTokens) && params.maxTokens > 0) {
    body.max_completion_tokens = Math.trunc(params.maxTokens);
  }
  if (Number.isFinite(params.temperature)) body.temperature = params.temperature;
  if (Number.isFinite(params.topP)) body.top_p = params.topP;
  if (Array.isArray(params.stop) && params.stop.length > 0) body.stop = params.stop;
  if (typeof params.reasoningEffort === 'string' && params.reasoningEffort !== '') {
    body.reasoning_effort = params.reasoningEffort;
  }

  let response;
  try {
    response = await fetch(`${API_ORIGIN}/deepai_code/chat/completions`, {
      method: 'POST',
      headers: requestHeaders({ apiKey: params.apiKey, sessionId: params.sessionId }),
      body: JSON.stringify(body),
      signal: params.signal,
    });
  } catch (error) {
    if (params.signal?.aborted) throw new UpstreamError('request aborted', 'ABORTED');
    throw new UpstreamError(`DeepAI request failed: ${error?.message ?? error}`, 'TRANSPORT');
  }

  if (!response.ok) throw await errorFor(response, 'DeepAI Code');

  const calls = new Map();
  let reason = 'stop';
  let usage;
  let synthetic = 0;

  for await (const chunk of readEvents(response, params.signal)) {
    if (chunk?.error) {
      throw new UpstreamError(
        `DeepAI Code error: ${String(chunk.error?.message ?? chunk.error)}`,
        'PROVIDER_ERROR',
        Number.isInteger(chunk.error?.status) ? { status: chunk.error.status } : {},
      );
    }
    if (chunk?.usage !== null && typeof chunk?.usage === 'object') {
      usage = completionsUsage(chunk.usage) ?? usage;
    }

    const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : undefined;
    if (choice === undefined) continue;
    const delta = choice.delta ?? {};

    if (typeof delta.content === 'string' && delta.content !== '') {
      yield { type: 'text', text: delta.content };
    }
    const reasoning = reasoningOf(delta);
    if (reasoning !== '') yield { type: 'reasoning', text: reasoning };

    for (const part of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const index = Number.isInteger(part?.index) ? part.index : 0;
      const call = calls.get(index) ?? { id: '', name: '', args: '', started: false };
      if (typeof part?.id === 'string' && part.id !== '') call.id = part.id;
      if (typeof part?.function?.name === 'string' && part.function.name !== '') {
        call.name = part.function.name;
      }
      const piece = typeof part?.function?.arguments === 'string' ? part.function.arguments : '';
      call.args += piece;
      calls.set(index, call);

      if (!call.started) {
        if (call.id === '') continue;
        call.started = true;
        yield { type: 'tool-start', id: call.id, name: call.name, arguments: call.args };
        continue;
      }
      if (piece !== '') yield { type: 'tool-arguments', id: call.id, delta: piece };
    }

    if (typeof choice.finish_reason === 'string') reason = mapFinishReason(choice.finish_reason);
  }

  for (const [index, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    if (call.started) continue;
    synthetic += 1;
    call.id = call.id === '' ? `deepai_call_${index}_${synthetic}` : call.id;
    yield { type: 'tool-start', id: call.id, name: call.name, arguments: call.args };
  }

  if (usage !== undefined) yield { type: 'usage', usage };
  yield { type: 'finish', reason: calls.size > 0 ? 'tool_calls' : reason };
}

/**
 * One streamed Responses call. This route has no stop-sequence field.
 *
 * @param {object} params - same shape as {@link streamChatCompletion}, where
 *   `messages` are harness-style blocks rather than OpenAI messages.
 * @yields {{type: string}}
 */
export async function* streamResponsesCompletion(params) {
  const body = {
    model: params.model,
    input: openAIToResponsesInput(params.messages),
    stream: true,
    store: false,
  };
  if (Number.isFinite(params.maxTokens) && params.maxTokens > 0) {
    body.max_output_tokens = Math.trunc(params.maxTokens);
  }
  if (Number.isFinite(params.temperature)) body.temperature = params.temperature;
  if (Number.isFinite(params.topP)) body.top_p = params.topP;
  const tools = openAIToResponsesTools(params.tools);
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (typeof params.reasoningEffort === 'string' && params.reasoningEffort !== '') {
    body.reasoning = { effort: params.reasoningEffort, summary: 'auto' };
    body.include = ['reasoning.encrypted_content'];
  }

  let response;
  try {
    response = await fetch(`${API_ORIGIN}/deepai_code/responses`, {
      method: 'POST',
      headers: requestHeaders({ apiKey: params.apiKey, sessionId: params.sessionId }),
      body: JSON.stringify(body),
      signal: params.signal,
    });
  } catch (error) {
    if (params.signal?.aborted) throw new UpstreamError('request aborted', 'ABORTED');
    throw new UpstreamError(`DeepAI request failed: ${error?.message ?? error}`, 'TRANSPORT');
  }

  if (!response.ok) throw await errorFor(response, 'DeepAI Code');

  const calls = new Map();
  let usage;
  let status = 'completed';
  let incomplete;
  let synthetic = 0;

  const keyOf = (event) =>
    typeof event?.item_id === 'string' && event.item_id !== ''
      ? event.item_id
      : String(event?.output_index ?? 0);

  const startCall = (call) => {
    call.started = true;
    return { type: 'tool-start', id: call.id, name: call.name, arguments: call.args };
  };

  for await (const event of readEvents(response, params.signal)) {
    const type = event?.type;
    if (type === 'error') {
      throw new UpstreamError(
        `DeepAI Code error: ${String(event?.message ?? event?.error?.message ?? 'unknown')}`,
        'PROVIDER_ERROR',
      );
    }
    if (type === 'response.failed') {
      throw new UpstreamError(
        `DeepAI Code error: ${String(event?.response?.error?.message ?? 'request failed')}`,
        'PROVIDER_ERROR',
      );
    }

    if (type === 'response.output_item.added' && event?.item?.type === 'function_call') {
      const item = event.item;
      const key = typeof item.id === 'string' && item.id !== '' ? item.id : keyOf(event);
      const call = calls.get(key) ?? { id: '', name: '', args: '', started: false };
      call.id = typeof item.call_id === 'string' && item.call_id !== '' ? item.call_id : call.id;
      call.name = typeof item.name === 'string' && item.name !== '' ? item.name : call.name;
      if (typeof item.arguments === 'string' && item.arguments !== '') call.args = item.arguments;
      calls.set(key, call);
      continue;
    }

    if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
      if (event.delta !== '') yield { type: 'text', text: event.delta };
      continue;
    }

    if (
      (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') &&
      typeof event.delta === 'string'
    ) {
      if (event.delta !== '') yield { type: 'reasoning', text: event.delta };
      continue;
    }

    if (type === 'response.function_call_arguments.delta') {
      const key = keyOf(event);
      const call = calls.get(key) ?? { id: '', name: '', args: '', started: false };
      const delta = typeof event.delta === 'string' ? event.delta : '';
      call.args += delta;
      calls.set(key, call);
      if (!call.started && call.id !== '') yield startCall(call);
      else if (call.started && delta !== '') yield { type: 'tool-arguments', id: call.id, delta };
      continue;
    }

    if (type === 'response.function_call_arguments.done') {
      const key = keyOf(event);
      const call = calls.get(key) ?? { id: '', name: '', args: '', started: false };
      const full = typeof event.arguments === 'string' ? event.arguments : '';
      const missing = full.startsWith(call.args) ? full.slice(call.args.length) : '';
      if (!full.startsWith(call.args)) call.args = full;
      else call.args = full;
      calls.set(key, call);
      if (!call.started && call.id !== '') yield startCall(call);
      else if (call.started && missing !== '') yield { type: 'tool-arguments', id: call.id, delta: missing };
      continue;
    }

    if (type === 'response.output_item.done' && event?.item?.type === 'function_call') {
      const item = event.item;
      const key = typeof item.id === 'string' && item.id !== '' ? item.id : keyOf(event);
      const call = calls.get(key) ?? { id: '', name: '', args: '', started: false };
      call.id = typeof item.call_id === 'string' && item.call_id !== '' ? item.call_id : call.id;
      call.name = typeof item.name === 'string' && item.name !== '' ? item.name : call.name;
      const full = typeof item.arguments === 'string' ? item.arguments : '';
      const missing = full.startsWith(call.args) ? full.slice(call.args.length) : '';
      call.args = full.startsWith(call.args) ? full : full;
      calls.set(key, call);
      if (!call.started && call.id !== '') yield startCall(call);
      else if (call.started && missing !== '') yield { type: 'tool-arguments', id: call.id, delta: missing };
      continue;
    }

    if (type === 'response.completed' || type === 'response.incomplete') {
      const result = event?.response ?? {};
      status = typeof result.status === 'string'
        ? result.status
        : type === 'response.incomplete' ? 'incomplete' : 'completed';
      incomplete = result.incomplete_details ?? undefined;
      usage = responsesUsage(result.usage) ?? usage;
      continue;
    }
  }

  for (const [key, call] of calls) {
    if (call.started) continue;
    synthetic += 1;
    call.id = call.id === '' ? `deepai_call_${String(key).replace(/\W/g, '')}_${synthetic}` : call.id;
    yield startCall(call);
  }

  let reason = 'stop';
  if (calls.size > 0) reason = 'tool_calls';
  else if (status === 'incomplete' && incomplete?.reason === 'max_output_tokens') reason = 'length';

  if (usage !== undefined) yield { type: 'usage', usage };
  yield { type: 'finish', reason };
}
