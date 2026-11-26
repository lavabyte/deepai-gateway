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
  ensureCatalog,
  findModel,
  publicModel,
  rateLabel,
} from '../deepai/catalog.js';
import {
  completionBody,
  responsesBody,
  streamChatCompletion,
  streamResponsesCompletion,
} from '../deepai/client.js';
import {
  CHARS_PER_TOKEN,
  contextWindowOf,
  promptBudgetFor,
} from '../deepai/window.js';
import { conversationId } from '../deepai/sessions.js';
import { creditsPerMinute, creditsPerThousand } from '../deepai/pricing.js';
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
  openAIContext,
  openAIFinish,
  openAIUsage,
  stopSequences,
} from '../openai.js';

/**
 * How big a prompt is, in the units that answer different questions.
 *
 * `count` is how many messages the caller sent, `chars` how much text they carry, `bytes` that
 * text in UTF-8. `bytes` is what the log reports, and the serialized body it belongs to is what
 * the wire-size guard is measured on - see `upstreamBodyBytes`. It is deliberately not called
 * context usage: the real token usage comes from DeepAI's response, see `openAIContext`.
 *
 * `imageBytes` is the payload of any image parts, counted apart so a log can say how much of a
 * prompt was an image rather than text. It is not subtracted from anything: an image is prompt
 * bytes like the rest.
 *
 * Both `bytes` and `chars` are written down for what arrived and what is forwarded, which is the
 * only way to answer "did this gateway cut my conversation?" from the log instead of from memory.
 *
 * @param {unknown} messages - OpenAI-shaped messages.
 * @returns {{count: number, chars: number, bytes: number, imageBytes: number}}
 */
function promptShape(messages) {
  let chars = 0;
  let bytes = 0;
  let imageBytes = 0;
  const add = (text) => {
    chars += text.length;
    bytes += Buffer.byteLength(text, 'utf8');
  };
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message === null || typeof message !== 'object') continue;
    const content = message.content;
    if (typeof content === 'string') add(content);
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (part === null || typeof part !== 'object') continue;
        if (typeof part.text === 'string') add(part.text);
        else if (typeof part.image_url?.url === 'string') {
          imageBytes += Buffer.byteLength(part.image_url.url, 'utf8');
        }
      }
    }
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      if (typeof call?.function?.arguments === 'string') add(call.function.arguments);
    }
  }
  return { count: Array.isArray(messages) ? messages.length : 0, chars, bytes, imageBytes };
}

/**
 * The caller's own name for this conversation, if it gave one.
 *
 * The app sends its per-thread id three ways: `session_id` for the OpenAI dialect,
 * `x-session-affinity` for the OpenRouter dialect, and `x-client-request-id` beside both.
 * The gateway's own `x-session-id` comes first because it is the explicit override. A blank
 * value is not a name, so it falls through to the next header and then to the derived id.
 *
 * @param {import('express').Request} req
 * @returns {string | undefined}
 */
function callerSession(req) {
  for (const name of ['x-session-id', 'session_id', 'x-session-affinity']) {
    const value = req.get(name);
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/**
 * The same context usage as {@link openAIContext}, in a response header.
 *
 * Only a non-streaming response can carry this: once an SSE stream has started, its headers are
 * gone and the top-level body cannot grow, so a stream reports the same object in its final usage
 * chunk instead. Nothing here is remembered: it is a view of DeepAI's `usage` for this one request.
 *
 * @param {object|undefined} context - the result of {@link openAIContext}.
 * @returns {string|undefined}
 */
function contextHeader(context) {
  if (context === undefined) return undefined;
  return [
    `used=${context.used_tokens}`,
    `prompt=${context.prompt_tokens}`,
    `completion=${context.completion_tokens}`,
    `cached=${context.cached_tokens}`,
    ...(context.window_tokens === undefined
      ? []
      : [
          `window=${context.window_tokens}`,
          `remaining=${context.remaining_tokens}`,
          `percent=${context.used_percent}`,
        ]),
  ].join('; ');
}

/**
 * The exact size of the request this gateway would send, in bytes.
 *
 * DeepAI's limit is on what it has to read, not on the prompt text: on a cold session, a body of
 * 195,809 bytes arrived whole and 196,811 did not, on two alphabets with token counts 70% apart.
 * That measurement is why the guard measures the body that would actually leave this process -
 * the serialized JSON, tools and framing included - rather than an estimate of the messages. The
 * measured wall is not a policy constant any more; the budget is the model's catalog entry.
 *
 * The two transports reshape the messages differently (`openAIToResponsesInput` drops what the
 * Responses dialect cannot carry and flattens tool wrappers), so the body is built per transport
 * through the same builder the transport itself uses, and measured on its serialized bytes.
 *
 * @param {object} params - the completion params, as passed to the transport.
 * @param {boolean} usesResponses - whether this model is served by `/deepai_code/responses`.
 * @returns {number} UTF-8 bytes of the body JSON.
 */
function upstreamBodyBytes(params, usesResponses) {
  const body = usesResponses ? responsesBody(params) : completionBody(params);
  return Buffer.byteLength(JSON.stringify(body), 'utf8');
}

/** Model used when a request omits one. */
const FALLBACK_MODEL = 'glm-5.3-flash';

/**
 * How long a stream may stay silent before a keep-alive comment is written.
 *
 * DeepAI can think for many seconds before its first delta. A proxy or a client that reads
 * nothing for that long has no way to tell a slow model from a dead connection.
 */
const KEEP_ALIVE_MS = 5_000;

/**
 * How often that silence is checked.
 *
 * Separate from the interval above so the rule is "nothing for five seconds" and not "a
 * multiple of five seconds since the last write": checking on the same grid skipped a whole
 * period whenever the last write landed a moment before a tick.
 */
const KEEP_ALIVE_TICK_MS = 1_000;

/**
 * How hard to try when DeepAI says the model is busy.
 *
 * It is not a fault in the request: the same request works a moment later, and that is what
 * the answer says. The desktop app waits `retry-after` and asks again for the same reason. A
 * caller that gets this as an error is being told to do retry logic the gateway can do for
 * it, so it does: three more attempts, inside a minute of waiting.
 */
const CAPACITY_ATTEMPTS = 3;
const CAPACITY_DEFAULT_WAIT_MS = 2_000;
const CAPACITY_MIN_WAIT_MS = 250;
const CAPACITY_MAX_WAIT_MS = 30_000;
const CAPACITY_TOTAL_WAIT_MS = 60_000;

/**
 * Mount the OpenAI-compatible routes.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{log?: (message: string) => void, logRequests?: boolean}} [options]
 * @returns {import('express').Router}
 */
export function v1Router(db, options = {}) {
  const router = express.Router();

  // Authenticated, and scoped to the key: a restricted key sees only the
  // models it is allowed to call.
  router.get('/models', authenticate(db), async (req, res) => {
    try {
      // Served from the copy the scheduled refresh keeps current. It is read from DeepAI
      // every ten to twenty minutes, at a random point in that window.
      const models = await ensureCatalog(AbortSignal.timeout(10_000), catalogKeyFor(db, req.gatewayKey));
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
          /*
           * The window a client should compact against: the one DeepAI sent for this model.
           *
           * There is no local 320,000 fallback. The catalog is the authority, and if it did not
           * send a window the field is omitted rather than replaced by a number this gateway
           * made up.
           */
          context_window: model.contextWindow,
          max_output_tokens: model.maxTokens,
          api: model.api,
          /*
           * The catalog's per-request figure, and what a request actually costs.
           *
           * The first is DeepAI's own number and it is a ceiling: measured, a real MiniMax M3
           * request cost 0.0082 Credits against a catalog figure of 2. The second is where the
           * equation puts that tier, in two units: per minute of generation, which is what the
           * pages show as `~0.60 Credits / min`, and per thousand tokens, for a caller pricing its
           * own token count. Both are `null` for a model the catalog sent no price for: a missing
           * number, not an invented one.
           */
          credits_per_request: model.theosPerRequest ?? null,
          credits_per_minute: creditsPerMinute(model.theosPerRequest),
          credits_per_thousand_tokens: creditsPerThousand(model.theosPerRequest),
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
      const models = await ensureCatalog(AbortSignal.timeout(10_000), catalogKeyFor(db, req.gatewayKey));
      const visible = models.filter((model) => allowsModel(req.gatewayKey, model.id));
      /*
       * The same window as `/v1/models`, on the richer view the dashboard reads.
       *
       * Easy to miss, because the dashboard is its only intended consumer - but this is a JSON
       * endpoint any key holder can call, so it has to agree with the number a harness would
       * compact against: both publish the catalog entry for that model.
       */
      res.json({
        object: 'list',
        data: visible.map((model) => ({
          ...publicModel(model),
          context_window: model.contextWindow,
        })),
      });
    } catch (error) {
      apiError(res, 502, catalogMessage(error), 'catalog_unavailable', 'api_error');
    }
  });

  router.post('/chat/completions', authenticate(db), enforceModel(FALLBACK_MODEL), (req, res, next) => {
    handleChatCompletion(db, req, res, options).catch(next);
  });

  return router;
}

/** Validate the request body and run one completion. */
async function handleChatCompletion(db, req, res, options = {}) {
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
  const catalogStart = Date.now();
  try {
    models = await ensureCatalog(AbortSignal.timeout(10_000), account.apiKey);
  } catch (error) {
    return apiError(res, 503, catalogMessage(error), 'catalog_unavailable', 'api_error');
  }
  const catalogMs = Date.now() - catalogStart;
  /*
   * The catalog read is the one thing this request does before DeepAI is asked anything, so
   * its cost is reported on the answer itself. It is the difference between a caller's
   * "the gateway is slow" and "the catalog read is slow today", and it is invisible from
   * outside otherwise.
   */
  res.setHeader('server-timing', `gwcatalog;dur=${catalogMs}`);
  const model = findModel(models, requestedModel);
  const upstreamModel = model?.id ?? requestedModel;
  const usesResponses = model?.api === 'openai-responses';

  const streamed = body.stream === true;

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
  const catalogAcceptsImages = acceptsImages(model);
  const recentlyRefused = imageCount > 0 && catalogAcceptsImages && rejectsImages(upstreamModel);
  const imagesSupported = catalogAcceptsImages && !recentlyRefused;
  let messages = imageCount > 0 && !imagesSupported
    ? withoutImages(body.messages)
    : body.messages;

  /*
   * Which session this request belongs to.
   *
   * The id only tells DeepAI which prompt cache to extend. Nothing about the conversation is
   * stored here: a caller's own session header wins, and otherwise the id is derived from the
   * first user message. That opening survives the system prompt being rewritten between turns
   * (date, cwd, model name), so normal turns keep the same cache. A compaction changes the
   * opening, so it gets a new id and a new cache - which is right, because the prompt prefix
   * changed too.
   *
   * The app's OpenAI client sends its per-thread id as `session_id`,
   * `x-client-request-id` and `x-session-affinity`; clients modelled on other providers send
   * the last one, or the gateway's own `x-session-id`. All three names are accepted, in that
   * order, so a harness that already knows its conversation keeps it across a compaction
   * instead of being re-keyed from the first message. `x-client-request-id` is deliberately
   * not read: some clients use it for one request, not one conversation.
   */
  const sessionId = callerSession(req) || conversationId(messages, owner);

  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  const log = options.logRequests !== false
    ? (options.log ?? ((message) => console.log(`[deepai-gateway] ${message}`)))
    : undefined;
  const startedAt = Date.now();

  /*
   * How big this request is, built and measured before anything is sent.
   *
   * The budget is not a constant in this file. It comes from the selected model's catalog entry:
   * `contextWindow - maxTokens`, converted at four units per token and then compared with the
   * serialized body's UTF-8 bytes. That keeps the guard aligned with the catalog, which can change
   * without a redeploy. An operator who measured a tighter limit on their own endpoint can still
   * set `PROMPT_BUDGET_BYTES`; the explicit value wins.
   *
   * This is a wire-size guard, not a context meter. Before the request is sent no exact token
   * count exists; after it, `openAIContext` reports DeepAI's real usage instead of guessing.
   *
   * A model the catalog sent no window for has no local budget. The gateway sends the prompt as
   * written instead of inventing a limit, and the refusal below stays out of the way.
   *
   * The number is the whole serialized request, not a cache-adjusted tail. The model's window has
   * to hold the cached prefix too, and the gateway keeps no conversation table to guess what
   * DeepAI has cached. DeepAI owns the cache; this gateway only decides whether the request fits.
   */
  const windowTokens = contextWindowOf(model);
  const promptBudgetChars = windowTokens === undefined ? undefined : windowTokens * CHARS_PER_TOKEN;
  const promptBudgetBytes = Number.isInteger(options.promptBudgetBytes) && options.promptBudgetBytes > 0
    ? options.promptBudgetBytes
    : promptBudgetFor(model);

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
  const upstreamBytes = upstreamBodyBytes(params, usesResponses);

  /*
   * The same facts on the wire, for a caller that never reads a log.
   *
   * `sent` and `received` are the prompt text in bytes - what leaves and what arrived. `body` is
   * the whole serialized upstream request, tools and framing included, and it is the number the
   * budget is measured against. `window` is the token window DeepAI's catalog declares for this
   * model, `budget` that window in characters, and `budget-bytes` the byte budget enforced below
   * (the model's window less its output allowance, or the operator's explicit override). A client
   * cannot learn any of this from DeepAI.
   *
   * The refusal below carries the same numbers. Semicolon-separated `key=value`, as it always was.
   */
  res.setHeader('x-gateway-prompt', [
    `sent=${promptShape(messages).bytes}`,
    `received=${promptShape(body.messages).bytes}`,
    `body=${upstreamBytes}`,
    `window=${windowTokens ?? 'unknown'}`,
    `budget=${promptBudgetChars ?? 'unknown'}`,
    ...(promptBudgetBytes === undefined ? [] : [`budget-bytes=${promptBudgetBytes}`]),
  ].join('; '));

  /*
   * A prompt past the model's budget is refused, not rewritten.
   *
   * The caller owns the conversation and its compaction: the harness compacts against the same
   * catalog window, and a checkpoint written here would put text on the wire the caller never saw,
   * then make the caller's original transcript arrive cold on the next turn. One chat is one
   * session here, so the honest answer is an error that asks for a compaction or a new chat rather
   * than a different prompt. A model with no catalog window has no budget and is forwarded as
   * written.
   */
  if (promptBudgetBytes !== undefined && upstreamBytes > promptBudgetBytes) {
    const promptText = upstreamBytes.toLocaleString('en-US');
    const budget = promptBudgetBytes.toLocaleString('en-US');
    log?.(`v1 ${upstreamModel} refused: ${upstreamBytes}B prompt over ${promptBudgetBytes}B budget `
      + `session=${sessionId.slice(0, 8)}`);
    record(db, {
      keyId: req.gatewayKey.id,
      keyName: req.gatewayKey.name,
      owner: req.gatewayKey.owner_username ?? '',
      model: upstreamModel,
      requestedModel,
      endpoint: 'chat.completions',
      status: 400,
      ok: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      durationMs: Date.now() - startedAt,
      firstTokenMs: null,
      streamed,
      errorCode: 'context_limit_reached',
    });
    return apiError(
      res,
      400,
      `This request's serialized prompt and tools are ${promptText} bytes, but this model's `
        + `catalog window allows at most ${budget} bytes. The gateway has not shortened it. `
        + `Compact the session, undo recent messages, or start a new chat, then retry. `
        + `The x-gateway-prompt header on this refusal carries the numbers.`,
      'context_limit_reached',
    );
  }

  const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  params.signal = controller.signal;

  // One writer per request: it builds the SSE envelope once and reuses it.
  const write = streamed ? makeWriter(res, id, upstreamModel, created) : undefined;

  const text = [];
  const reasoning = [];
  const calls = new Map();
  let usage;
  let finish = 'stop';
  let firstTokenMs;
  let roleSent = false;
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
      /*
       * DeepAI has accepted the request. Its headers are here long before its first token,
       * and opening the stream only on that token made a caller wait for the whole model
       * before seeing a single byte - which is exactly the "the gateway is slow" it read as,
       * when the wait was the model thinking upstream.
       *
       * So the stream is opened here, with the role delta OpenAI itself sends first, and the
       * bytes of the answer follow as they arrive. The status is settled at this point too,
       * so a refusal still reaches the caller as a refusal rather than as a 200.
       */
      if (event.type === 'open') {
        if (write !== undefined && !roleSent) {
          roleSent = true;
          write({ role: 'assistant' });
        }
        continue;
      }
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

  /*
   * One attempt, and then as many more as a busy worker is worth.
   *
   * Retried only while nothing has reached the caller: a refusal is retried, a half-written
   * answer never is, because a second answer appended to a partial one is worse than the
   * error it replaces.
   */
  let waitedMs = 0;
  const runAttempt = async (attemptParams) => {
    for (let tries = 1; ; tries += 1) {
      try {
        await attempt(attemptParams);
        return;
      } catch (error) {
        /*
         * Nothing of the answer itself has been forwarded. The role delta does not count: it
         * carries no content, so a retry after it still produces one well-formed message
         * (role, then the answer). A retry after any text, reasoning or tool call does not,
         * because the caller would be reading two answers spliced together.
         */
        const untouched = text.length === 0 && reasoning.length === 0 && calls.size === 0;
        const wait = capacityWait(error, tries, untouched);
        if (wait === undefined || waitedMs + wait > CAPACITY_TOTAL_WAIT_MS) throw error;
        waitedMs += wait;
        log?.(`v1 ${upstreamModel} capacity: the model is busy, waiting ${wait}ms `
          + `(attempt ${tries + 1} of ${CAPACITY_ATTEMPTS + 1})`);
        await pause(wait, controller.signal);
      }
    }
  };

  try {
    await runAttempt(params);
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
    /*
     * The retry carries different messages, so it is measured too.
     *
     * Stripping an image normally shrinks the request - a data URL is replaced by a short note -
     * but the note is a fixed length and a small enough image is shorter than it, so the retry can
     * be a few dozen bytes larger per image than the part that was checked. At a model-derived
     * budget that cannot cross the limit, and an operator who sets `PROMPT_BUDGET_BYTES` must not
     * lose the one invariant this guard exists for: nothing unmeasured goes upstream.
     */
    const retryMessages = withoutImages(body.messages);
    const retryParams = { ...params, messages: retryMessages };
    const retryBytes = upstreamBodyBytes(retryParams, usesResponses);
    if (promptBudgetBytes !== undefined && retryBytes > promptBudgetBytes) {
      status = 400;
      errorCode = 'context_limit_reached';
      failure = new UpstreamError(
        `The text-only retry after the image refusal is `
          + `${retryBytes.toLocaleString('en-US')} bytes, over this gateway's `
          + `${promptBudgetBytes.toLocaleString('en-US')}-byte prompt budget. `
          + 'Compact the session, undo recent messages, or start a new chat, '
          + 'then send the question without the image.',
        'CONTEXT_LIMIT_REACHED',
        { status: 400 },
      );
    } else {
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
        await runAttempt(retryParams);
      } catch (retryError) {
        status = retryError?.code === 'ABORTED' ? 499 : (retryError?.status ?? 502);
        errorCode = retryError?.code === 'ABORTED' ? 'client_closed' : (retryError?.code ?? 'gateway_error');
        failure = retryError;
      }
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

  /*
   * What this answer actually occupied, from DeepAI's own usage and nothing else.
   *
   * There is no estimate to fall back on: if DeepAI did not report usage, the honest answer is
   * that the gateway does not know, so the standard `usage` field stays absent and no `context`
   * object is invented. The desktop app, the harness and every OpenAI client already know how to
   * read `usage`; `context` is the same numbers with the model's window and percentage attached.
   */
  const context = openAIContext(usage, windowTokens);

  if (status === 200 && streamed) {
    write({}, openAIFinish(effectiveFinish));
    res.write(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model: upstreamModel,
      choices: [],
      usage: openAIUsage(usage),
      ...(context === undefined ? {} : { context }),
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } else if (status === 200) {
    // Nothing has been written yet, so the whole split can still ride on the answer.
    const timing = [`gwcatalog;dur=${catalogMs}`];
    if (firstTokenMs !== undefined) timing.push(`gwmodel;dur=${firstTokenMs}`);
    res.setHeader('server-timing', timing.join(', '));
    const header = contextHeader(context);
    if (header !== undefined) res.setHeader('x-gateway-context', header);
    res.json({
      ...completion({
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
        usage: openAIUsage(usage),
      }),
      ...(context === undefined ? {} : { context }),
    });
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
 * The DeepAI key a catalog read is authenticated with.
 *
 * The catalog is read as the account that owns the gateway key: `os GATEWAY` rows in
 * `api_keys` hold only a hash of the caller's `sk-` key, never a DeepAI credential, so
 * `gatewayKey.api_key` was always `undefined` - and lane 6 answers that with 401, which
 * surfaced as a catalog failure on `/v1/models` and on every completion that needed the
 * catalog. The DeepAI key lives on the owning account.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{owner_username?: string}} gatewayKey
 * @returns {string|undefined}
 */
function catalogKeyFor(db, gatewayKey) {
  return readAccount(db, gatewayKey?.owner_username ?? '')?.apiKey;
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
  let lastWrite = Date.now();

  /*
   * Bytes while the model is silent.
   *
   * A comment line is not data - every SSE reader discards it - so it cannot disturb a
   * client, and it keeps a nearly idle connection visibly alive through whatever proxy sits
   * between this gateway and the caller.
   */
  const pulse = setInterval(() => {
    if (!opened || res.writableEnded || res.destroyed) return;
    if (Date.now() - lastWrite < KEEP_ALIVE_MS) return;
    res.write(': keep-alive\n\n');
    lastWrite = Date.now();
  }, KEEP_ALIVE_TICK_MS);
  pulse.unref?.();
  res.on('close', () => clearInterval(pulse));

  const envelope = `data: {"id":${JSON.stringify(id)},"object":"chat.completion.chunk","created":${created},"model":${JSON.stringify(model)},"choices":[{"index":0,"delta":`;
  return (delta, finishReason = null) => {
    if (!opened) {
      opened = true;
      openEventStream(res, 200);
    }
    lastWrite = Date.now();
    res.write(`${envelope}${JSON.stringify(delta)},"finish_reason":${finishReason === null ? 'null' : JSON.stringify(finishReason)}}]}\n\n`);
  };
}

/**
 * How long to wait before asking a busy worker again, or undefined to stop trying.
 *
 * `retry-after` is what DeepAI asked for when it sends one; otherwise a couple of seconds,
 * which is what the app uses. The bounds keep a hostile or mistaken header from parking a
 * caller's request for minutes or from retrying in a tight loop.
 *
 * @param {unknown} error
 * @param {number} tries - attempts made so far, counting the one that failed.
 * @param {boolean} untouched - whether anything has reached the caller.
 * @returns {number|undefined}
 */
function capacityWait(error, tries, untouched) {
  if (!untouched) return undefined;
  if (!(error instanceof UpstreamError) || error.code !== 'CAPACITY') return undefined;
  if (tries > CAPACITY_ATTEMPTS) return undefined;
  const asked = Number.isFinite(error.providerRetryAfterMs) ? error.providerRetryAfterMs : CAPACITY_DEFAULT_WAIT_MS;
  return Math.min(Math.max(asked, CAPACITY_MIN_WAIT_MS), CAPACITY_MAX_WAIT_MS);
}

/** Wait, unless the caller goes away first. */
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UpstreamError('request aborted', 'ABORTED'));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new UpstreamError('request aborted', 'ABORTED'));
    };
    // eslint-disable-next-line no-use-before-define -- assigned before the timer can fire.
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Accept only finite numbers. */
function numberOrUndefined(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
