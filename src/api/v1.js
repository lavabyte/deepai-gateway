/**
 * OpenAI-compatible surface: `/v1/models` and `/v1/chat/completions`.
 *
 * Clients point any OpenAI SDK at this gateway. Streaming and non-streaming
 * requests are both supported; either way exactly one usage row is written, so
 * the dashboard can never miss a call or count one twice.
 *
 * `/v1/models` requires a key and only advertises the models that key may use,
 * so a client can never see - or try - a model its key is not entitled to.
 *
 * @module deepai-gateway/api/v1
 */

import { randomUUID } from 'node:crypto';
import express from 'express';
import {
  CatalogUnavailable,
  REASONING_LEVELS,
  displayName,
  fetchCatalog,
  findModel,
  publicModel,
  rateLabel,
} from '../deepai/catalog.js';
import { streamChatCompletion, streamResponsesCompletion } from '../deepai/client.js';
import { UpstreamError } from '../deepai/wire.js';
import { acceptsImages, countImages, withoutImages } from '../deepai/images.js';
import { isMultimodalRejection, noteMultimodalRejection, rejectsImages } from '../deepai/multimodal.js';
import { allowsModel } from '../keys.js';
import { authenticate, enforceModel, apiError } from '../middleware/auth.js';
import { readAccount } from '../store.js';
import { record } from '../usage.js';
import {
  chunk,
  completion,
  effortOf,
  requestedEffort,
  openAIFinish,
  openAIUsage,
  stopSequences,
} from '../openai.js';

/** Model used when a request omits one. */
const FALLBACK_MODEL = 'glm-5.3-flash';

/**
 * Mount the OpenAI-compatible routes.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {import('express').Router}
 */
export function v1Router(db) {
  const router = express.Router();

  // Authenticated, and scoped to the key: a restricted key sees only the
  // models it is allowed to call.
  router.get('/models', authenticate(db), async (req, res) => {
    try {
      // Read on every call: there is no cache and no embedded list, so a model exists
      // because DeepAI says so now.
      const models = await fetchCatalog(AbortSignal.timeout(10_000));
      const visible = models.filter((model) => allowsModel(req.gatewayKey, model.id));
      res.json({
        object: 'list',
        data: visible.map((model) => ({
          id: model.id,
          object: 'model',
          created: 0,
          owned_by: 'deepai',
          // Identity
          name: model.name,
          display_name: displayName(model),
          description: publicModel(model).description,
          // Tier
          tier: model.premier ? 'premier' : 'free',
          premier: model.premier,
          // Capabilities
          reasoning: model.reasoning,
          reasoning_levels: model.reasoning ? REASONING_LEVELS.map((level) => level.id) : [],
          input_modalities: [...model.input],
          output_modalities: ['text'],
          context_window: model.contextWindow,
          max_output_tokens: model.maxTokens,
          api: model.api,
          // What one request costs, which is how DeepAI bills.
          theos_per_request: model.theosPerRequest ?? null,
          rate_label: rateLabel(model),
        })),
      });
    } catch (error) {
      apiError(res, 502, catalogMessage(error), 'catalog_unavailable', 'api_error');
    }
  });

  // A richer view used by the dashboard's Models tab. Same scoping rules.
  router.get('/models/details', authenticate(db), async (req, res) => {
    try {
      const models = await fetchCatalog(AbortSignal.timeout(10_000));
      const visible = models.filter((model) => allowsModel(req.gatewayKey, model.id));
      res.json({ object: 'list', data: visible.map(publicModel) });
    } catch (error) {
      apiError(res, 502, catalogMessage(error), 'catalog_unavailable', 'api_error');
    }
  });

  router.post('/chat/completions', authenticate(db), enforceModel(FALLBACK_MODEL), (req, res, next) => {
    handleChatCompletion(db, req, res).catch(next);
  });

  return router;
}

/** Validate the request body and run one completion. */
async function handleChatCompletion(db, req, res) {
  const body = req.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return apiError(res, 400, 'The request body must be a JSON object.', 'invalid_body');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return apiError(res, 400, '"messages" must be a non-empty array.', 'invalid_messages');
  }

  // The key's owner decides which DeepAI account pays for this call. Before
  // multi-user support this read one global row, so every key billed the same
  // account - and a key whose owner had signed out would silently run on
  // whoever happened to be signed in.
  const owner = req.gatewayKey.owner_username ?? '';
  const account = readAccount(db, owner);
  if (account === undefined) {
    return apiError(
      res,
      503,
      owner === ''
        ? 'This API key has no DeepAI account. Recreate it from a signed-in dashboard.'
        : `The DeepAI account "${owner}" that owns this API key is not signed in. Log in again from the dashboard.`,
      'deepai_signed_out',
      'api_error',
    );
  }

  const requestedModel = typeof body.model === 'string' && body.model !== '' ? body.model : FALLBACK_MODEL;

  /*
   * The catalog is read before the model is resolved, because it is the only thing that
   * knows what a model is: whether it exists, which upstream API it uses, and whether it
   * can take an image. There is no copy to fall back on, so a network failure here stops the
   * request with a clear answer instead of guessing - asking DeepAI for a model it may not
   * have would fail later, with a message that explains nothing.
   */
  let models;
  try {
    models = await fetchCatalog(AbortSignal.timeout(10_000));
  } catch (error) {
    return apiError(res, 503, catalogMessage(error), 'catalog_unavailable', 'api_error');
  }
  const model = findModel(models, requestedModel);
  const upstreamModel = model?.id ?? requestedModel;
  const usesResponses = model?.api === 'openai-responses';

  const streamed = body.stream === true;
  // The session id groups a caller's requests for upstream prompt-cache affinity.
  const sessionId = req.get('x-session-id') ?? req.gatewayKey.id;

  /*
   * An image is only sent to a model that can actually take one.
   *
   * Two ways a model cannot, and the catalog only knows the first:
   *
   *  - it does not declare `image` in its input, which is what the app checks too;
   *  - it declares it, and the backend still refuses with "Received multimodal data but
   *    multimodal processing is not enabled". The app's own source names this case and
   *    remembers the refusal for later turns; a gateway has no turn, so it is remembered
   *    across requests instead (`multimodal.js`).
   *
   * Either way the image is replaced by a note in the text, so the rest of the prompt still
   * reaches the model.
   */
  const imageCount = countImages(body.messages);
  const imagesSupported = acceptsImages(model) && !rejectsImages(upstreamModel);
  const messages = imageCount > 0 && !imagesSupported
    ? withoutImages(body.messages)
    : body.messages;

  const params = {
    apiKey: account.apiKey,
    model: upstreamModel,
    messages,
    tools: body.tools,
    maxTokens: numberOrUndefined(body.max_completion_tokens ?? body.max_tokens),
    temperature: numberOrUndefined(body.temperature),
    topP: numberOrUndefined(body.top_p),
    stop: usesResponses ? [] : stopSequences(body.stop),
    // Whatever spelling the caller used: `reasoning_effort`, `thinking_level`, or a nested
    // `reasoning.effort`. Reading only the first is why an effort could look unsent.
    reasoningEffort: effortOf(requestedEffort(body)),
    sessionId,
    signal: undefined,
  };

  const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const startedAt = Date.now();

  const controller = new AbortController();
  params.signal = controller.signal;
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  // One writer per request: it builds the SSE envelope once and reuses it.
  const write = streamed ? makeWriter(res, id, upstreamModel, created) : undefined;

  const text = [];
  const reasoning = [];
  const calls = new Map();
  let usage;
  let finish = 'stop';
  let firstTokenMs;
  let status = 200;
  let errorCode;
  let failure;

  /**
   * Run one upstream attempt and collect it into the accumulators above.
   *
   * Pulled out of the handler so the multimodal refusal can be retried: a backend that
   * rejects an image still answers the same prompt as text, and asking it again costs the
   * caller nothing but a round trip.
   *
   * @param {object} attempt - the params to send.
   * @returns {Promise<void>}
   */
  const attempt = async (attemptParams) => {
    const source = usesResponses
      ? streamResponsesCompletion(attemptParams)
      : streamChatCompletion(attemptParams);
    for await (const event of source) {
      if (firstTokenMs === undefined) firstTokenMs = Date.now() - startedAt;
      if (event.type === 'text') {
        text.push(event.text);
        if (write !== undefined) write({ content: event.text });
        continue;
      }
      if (event.type === 'reasoning') {
        reasoning.push(event.text);
        if (write !== undefined) write({ reasoning_content: event.text });
        continue;
      }
      if (event.type === 'tool-start') {
        const call = {
          id: String(event.id ?? ''),
          name: String(event.name ?? ''),
          args: String(event.arguments ?? ''),
          index: calls.size,
        };
        calls.set(call.id, call);
        if (write !== undefined) {
          write({
            tool_calls: [{
              index: call.index,
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.args },
            }],
          });
        }
        continue;
      }
      if (event.type === 'tool-arguments') {
        const call = calls.get(String(event.id ?? ''));
        if (call === undefined) continue;
        call.args += event.delta;
        if (write !== undefined) {
          write({
            tool_calls: [{
              index: call.index,
              function: { arguments: event.delta },
            }],
          });
        }
        continue;
      }
      if (event.type === 'usage') {
        usage = event.usage;
        continue;
      }
      if (event.type === 'finish') {
        finish = event.reason ?? 'stop';
      }
    }
  };

  try {
    await attempt(params);
  } catch (error) {
    if (error?.code === 'ABORTED') {
      status = 499;
      errorCode = 'client_closed';
    } else if (error instanceof UpstreamError) {
      status = error.status ?? 502;
      errorCode = error.code;
      failure = error;
    } else {
      status = 502;
      errorCode = 'gateway_error';
      failure = error;
    }
  }

  /*
   * Retried once without the images when the backend refuses multimodal input.
   *
   * The refusal is a property of the model's worker, not of this prompt, so the same
   * question asked as text is answered normally. The caller gets that answer instead of an
   * error about a flag on somebody else's server, and the model is remembered as unable so
   * the next request is filtered before it is sent.
   *
   * Two refusals are recognised, because DeepAI has answered with both and neither names the
   * image as the cause:
   *
   *  - the worker's own `Received multimodal data but multimodal processing is not enabled`;
   *  - a plain `HTTP 400` whose body says only "The model provider rejected this request. Try
   *    reducing the conversation or attachments, or choose another model." Measured against a
   *    live gateway, every image shape and every model that advertises `image` produces this,
   *    while the same prompt as text is answered - so on a request that carried an image, a
   *    400 is the image.
   */
  const imageRefused = failure !== undefined && imageCount > 0
    && (isMultimodalRejection(failure.message) || failure.status === 400);
  if (imageRefused) {
    noteMultimodalRejection(upstreamModel);
    text.length = 0;
    reasoning.length = 0;
    calls.clear();
    usage = undefined;
    finish = 'stop';
    firstTokenMs = undefined;
    status = 200;
    errorCode = undefined;
    failure = undefined;
    try {
      await attempt({ ...params, messages: withoutImages(body.messages) });
    } catch (retryError) {
      status = retryError?.code === 'ABORTED' ? 499 : (retryError?.status ?? 502);
      errorCode = retryError?.code === 'ABORTED' ? 'client_closed' : (retryError?.code ?? 'gateway_error');
      failure = retryError;
    }
  }

  const toolCalls = [...calls.values()].filter((call) => call.name !== '');
  const effectiveFinish = toolCalls.length > 0 ? 'tool_calls' : finish;

  /*
   * The backend refusing multimodal input is its own failure, and it is instructive.
   *
   * It arrives as a provider error carrying the worker's `ValueError`, which tells a caller
   * nothing about what to do and names a flag they cannot set. The model is recorded as
   * unable to take images, so the next request for it is filtered before it is sent, and
   * this caller is told that plainly.
   */
  if (failure !== undefined && imageCount > 0 && isMultimodalRejection(failure.message)) {
    noteMultimodalRejection(upstreamModel);
    status = 502;
    errorCode = 'image_not_supported';
    failure = new UpstreamError(
      `DeepAI refused the ${imageCount === 1 ? 'image' : `${imageCount} images`} for "${upstreamModel}": the backend has no multimodal processing enabled for it, whatever its catalog says. `
      + 'This model will be sent text only from now on; send the question as text, or use a model that takes images.',
      'IMAGE_NOT_SUPPORTED',
      { status: 502 },
    );
  }

  /*
   * A reply with no text and no tool call is not a completed turn.
   *
   * It is what a model returns when it cannot use its input - the multimodal image case is
   * the one this was found on - and reporting it as `finish_reason: "stop"` with an empty
   * message tells the caller the model had nothing to say. The two causes are named
   * separately, because they need different fixes: an image the model cannot take, or an
   * upstream that returned nothing for a reason only the caller can see.
   */
  if (status === 200 && upstreamModel !== 'deepai-cyber' && text.join('') === ''
    && reasoning.length === 0 && toolCalls.length === 0) {
    status = 502;
    errorCode = imageCount > 0 && !imagesSupported ? 'image_not_supported' : 'empty_completion';
    failure = new UpstreamError(
      imageCount > 0 && !imagesSupported
        ? `"${upstreamModel}" returned no content. It does not accept images, so the ${imageCount === 1 ? 'image was' : `${imageCount} images were`} left out of the request; send the question as text, or use a model that takes images.`
        : `"${upstreamModel}" returned a completed response with no content.`,
      errorCode,
    );
  }

  if (status === 200 && streamed) {
    write({}, openAIFinish(effectiveFinish));
    if (usage !== undefined) {
      res.write(`data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: upstreamModel,
        choices: [],
        usage: openAIUsage(usage),
      })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } else if (status === 200) {
    res.json(completion({
      id,
      model: upstreamModel,
      created,
      message: {
        role: 'assistant',
        content: text.join('') === '' ? null : text.join(''),
        ...(reasoning.length > 0 ? { reasoning_content: reasoning.join('') } : {}),
        ...(toolCalls.length > 0
          ? {
              tool_calls: toolCalls.map((call, index) => ({
                index,
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.args === '' ? '{}' : call.args },
              })),
            }
          : {}),
      },
      finishReason: openAIFinish(effectiveFinish),
      usage: openAIUsage(usage) ?? {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    }));
  } else {
    if (streamed) {
      // A streaming failure still has to look like a stream: without the SSE
      // content type an SDK parsing the response as an event stream would be
      // reading an unknown content type, and a proxy could buffer or rewrite it.
      openEventStream(res, status);
      res.write(`data: ${JSON.stringify({
        error: {
          message: failure?.message ?? 'Upstream request failed.',
          type: 'api_error',
          code: errorCode ?? 'upstream_error',
          param: null,
        },
      })}\n\n`);
      res.end();
    } else {
      apiError(
        res,
        status === 499 ? 499 : status,
        failure?.message ?? 'Upstream request failed.',
        errorCode ?? 'upstream_error',
        'api_error',
      );
    }
  }

  record(db, {
    keyId: req.gatewayKey.id,
    keyName: req.gatewayKey.name,
    // The owner travels on the usage row so the history stays attributable
    // even after the key itself is deleted.
    owner: req.gatewayKey.owner_username ?? '',
    model: upstreamModel,
    requestedModel,
    endpoint: 'chat.completions',
    status,
    ok: status === 200,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cacheReadTokens: usage?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
    reasoningTokens: usage?.reasoningTokens ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
    durationMs: Date.now() - startedAt,
    firstTokenMs: firstTokenMs ?? null,
    streamed,
    errorCode: errorCode ?? null,
  });
}

/**
 * What to tell a caller when the catalog could not be read.
 *
 * `CatalogUnavailable` already says which of the three it was - unreachable, refused, or an
 * answer that was not a catalog. Anything else is a bug in this gateway and is not described
 * as a network problem.
 *
 * @param {unknown} error
 * @returns {string}
 */
function catalogMessage(error) {
  if (error instanceof CatalogUnavailable) return `${error.message}. The model list cannot be read, so the request cannot be routed.`;
  return String(error?.message ?? error);
}

/**
 * Send the response headers for a server-sent-events stream.
 *
 * Shared by the success path and the failure path: a stream that fails before
 * its first delta must still be framed as a stream. Setting the status only when
 * headers have not been sent keeps this safe to call after a partial stream.
 *
 * @param {import('express').Response} res
 * @param {number} [status] - status to use when the headers are still ours.
 */
function openEventStream(res, status) {
  if (res.headersSent) return;
  res.status(status ?? 200);
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders?.();
  // Without this, small writes can be held back by Nagle's algorithm and
  // arrive in bursts instead of streaming.
  res.socket?.setNoDelay?.(true);
}

/**
 * Write one SSE chunk, opening the stream on first use.
 *
 * The envelope up to and including `"delta":` is built once per request, so a
 * stream of hundreds of deltas only serializes the delta object itself instead
 * of rebuilding the whole chunk each time.
 */
function makeWriter(res, id, model, created) {
  let opened = false;
  const envelope = `data: {"id":${JSON.stringify(id)},"object":"chat.completion.chunk","created":${created},"model":${JSON.stringify(model)},"choices":[{"index":0,"delta":`;
  return (delta, finishReason = null) => {
    if (!opened) {
      opened = true;
      openEventStream(res, 200);
    }
    res.write(`${envelope}${JSON.stringify(delta)},"finish_reason":${finishReason === null ? 'null' : JSON.stringify(finishReason)}}]}\n\n`);
  };
}

/** Accept only finite numbers. */
function numberOrUndefined(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
