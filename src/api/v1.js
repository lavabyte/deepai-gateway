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
  CONTEXT_WINDOW_TOKENS,
  PROMPT_BUDGET_BYTES,
  PROMPT_BUDGET_CHARS,
  PROMPT_WALL_BYTES,
} from '../deepai/window.js';
import { fitPrompt } from '../deepai/fit.js';
import { freshMessages, rememberSession, resolveSession } from '../deepai/sessions.js';
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
  openAIFinish,
  openAIUsage,
  stopSequences,
} from '../openai.js';

/**
 * How big a prompt is, in the units that answer different questions.
 *
 * `count` is how many messages the caller sent, `chars` how much text they carry, `bytes` that
 * text in UTF-8. `chars` is the unit the token meter in `estimateUsage` reads: `chars /
 * CHARS_PER_TOKEN` is the same `prompt_tokens` this gateway reports when DeepAI sends no usage.
 * `bytes` is what the log reports, and the serialized body it belongs to is what the fresh-byte
 * budget is measured on - see `upstreamBodyBytes` and `freshBodyBytes`.
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
 * The exact size of the request this gateway would send, in bytes.
 *
 * DeepAI's limit is on what it has to read, not on the prompt text: measured on a cold session,
 * 195,809 bytes of body arrived whole and 196,811 did not, on two alphabets with token counts 70%
 * apart. So the guard measures the body that would actually leave this process - the serialized
 * JSON, tools and framing included - rather than an estimate of the messages, which can sit under
 * a budget while the body that carries it sits over the wall.
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

/**
 * The bytes this request makes the endpoint read fresh, in the same unit as the wall.
 *
 * A conversation whose prefix the endpoint already cached costs nothing to carry: only the
 * messages after the last one the stored tail covers are read fresh, and that is the part the
 * 196 KB wall applies to. Those messages are measured as the transport would serialize them, so
 * an image part or a tool call counts what it actually weighs.
 *
 * With nothing covered - a cold conversation, or one this account has no row for - the fresh part
 * is the whole serialized body, tools and framing included, which is the number the budget has
 * always measured. On a warm one it is the tail, measured through the same body builder so the
 * tool catalog and framing are not invisible to the guard.
 *
 * @param {object} params - the completion params, as passed to the transport.
 * @param {Array<object>} messages - the messages that would be sent.
 * @param {string[]} covered - digests the endpoint should already have cached.
 * @param {boolean} usesResponses - whether this model is served by `/deepai_code/responses`.
 * @returns {number} UTF-8 bytes.
 */
function freshBodyBytes(params, messages, covered, usesResponses) {
  const fresh = freshMessages(covered, messages);
  if (fresh === messages) return upstreamBodyBytes(params, usesResponses);
  return upstreamBodyBytes({ ...params, messages: fresh }, usesResponses);
}

/**
 * The transcript in one readable line: how many of each role, and whether a system prompt is
 * among them.
 *
 * An answer that says "Hi, how can I help you today?" to a working conversation and an answer
 * to a conversation that arrived without its system prompt look identical from outside. This
 * is what tells them apart in a log, without writing anybody's prompt into it.
 *
 * @param {unknown} messages
 * @returns {string}
 */
function transcriptShape(messages) {
  const counts = new Map();
  let systemFirst = false;
  const list = Array.isArray(messages) ? messages : [];
  for (const [index, message] of list.entries()) {
    const role = typeof message?.role === 'string' ? message.role : 'none';
    if (index === 0 && (role === 'system' || role === 'developer')) systemFirst = true;
    const toolCall = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
    const label = toolCall ? `${role}+tool_calls` : role;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = [...counts].map(([label, count]) => `${label}:${count}`);
  return `${systemFirst ? 'sys-first' : 'NO-SYSTEM-FIRST'} ${parts.join(',')}`;
}

/** Model used when a request omits one. */
const FALLBACK_MODEL = 'glm-5.3-flash';

/**
 * The model that writes a checkpoint when a prompt has to be compacted.
 *
 * A compaction is work the gateway does for the caller, so it must not appear on the caller's
 * bill: only a free model is eligible, and the catalog's own `premier` flag is the authority.
 * Models served by `/responses` are skipped because the summarizer speaks chat-completions.
 *
 * @param {Array<object>} models - the catalog.
 * @returns {string|undefined} a model id, or undefined when the catalog lists no free model.
 */
function freeCompactionModel(models) {
  const free = (Array.isArray(models) ? models : []).filter((model) => model?.premier !== true
    && model?.api !== 'openai-responses'
    && Array.isArray(model?.input)
    && model.input.includes('text'));
  if (free.length === 0) return undefined;
  return (free.find((model) => model.id === FALLBACK_MODEL) ?? free[0]).id;
}

/** Per-message structural overhead for role framing and JSON framing. */
const MESSAGE_OVERHEAD = 10;

/**
 * Estimate token usage when DeepAI does not send `usage` in the stream.
 *
 * DeepAI does not include `usage` in streamed chat-completions chunks, so the
 * gateway would otherwise emit `prompt_tokens: 0, completion_tokens: 0` - which
 * makes every client (including the harness context meter) report ~0% context
 * usage. As a fallback, estimate from the request messages and the generated
 * answer. It is deliberately approximate: better than zeros, never presented as
 * exact upstream accounting.
 *
 * @param {Array<object>} messages - the request messages (OpenAI shape).
 * @param {string[]} text - accumulated answer text deltas.
 * @param {string[]} reasoning - accumulated reasoning deltas.
 * @returns {{inputTokens:number, outputTokens:number, totalTokens:number, cacheReadTokens:number, cacheWriteTokens:number, reasoningTokens:number}}
 */
function estimateUsage(messages, text, reasoning) {
    let chars = 0;
    for (const m of messages) {
        if (typeof m.content === 'string') chars += m.content.length;
        else if (Array.isArray(m.content)) {
            for (const part of m.content) {
                if (part.type === 'text') chars += part.text.length;
                else if (part.type === 'image_url') chars += 1024;
            }
        }
        chars += MESSAGE_OVERHEAD;
    }
    const inputTokens = Math.max(0, Math.floor(chars / CHARS_PER_TOKEN));
    const outputText = text.join('');
    const outputReasoning = reasoning.join('');
    const outputTokens = Math.max(0, Math.floor((outputText.length + outputReasoning.length) / CHARS_PER_TOKEN));
    return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: Math.max(0, Math.floor(outputReasoning.length / CHARS_PER_TOKEN)),
    };
}

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
           * The window a client should compact against: DeepAI's own 320,000.
           *
           * It is what the desktop app reads out of the same catalog and spreads into its model
           * config, and it compacts at `contextWindow - reserveTokens`, which is where its
           * observed compactions at about 290,000 tokens come from. It is also what this gateway
           * serves: a conversation whose prefix is cached is forwarded however large it is, so a
           * warm 290,000-token chat works here exactly as it works in the app.
           *
           * The real limit is elsewhere and is not a window: the endpoint silently discards the
           * front of a prompt it has to read FRESH past about 196 KB. That is enforced on the
           * request path against the fresh part only, which is why a number that fits the whole
           * conversation is the honest one to publish here.
           */
          context_window: CONTEXT_WINDOW_TOKENS,
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
       * compact against, and it does: both publish the catalog's own 320,000.
       */
      res.json({
        object: 'list',
        data: visible.map((model) => ({
          ...publicModel(model),
          context_window: CONTEXT_WINDOW_TOKENS,
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
   * What happened to the images, for the log.
   *
   * Without this an image that never reached the model and an image the model saw but
   * ignored look exactly the same from the answer - both come back as text that does not
   * mention it. The reason is kept separate because each has a different fix: `catalog` is
   * DeepAI saying the model has no vision, `refused-recently` is this gateway's own memory
   * of a refusal (it expires), and `sent` means the image left the gateway.
   */
  /*
   * What the caller sent, and what this gateway would send on. An image can take a message out of
   * the second one, so the two are not always equal - and a log that only showed the first would
   * hide exactly the change a reader would need to explain a strange answer.
   */
  const arrived = promptShape(body.messages);
  const forwarded = promptShape(messages);

  /*
   * Which session this request belongs to, and what of its prompt the endpoint already has.
   *
   * The session id is what DeepAI keeps a conversation's prompt cache on. This gateway used to
   * derive it from the conversation's opening alone, which stayed stable until the harness
   * compacted - the opening becomes a summary - or rewrote its system prompt, which harnesses do
   * (date, cwd, model name). Then the id changed, the endpoint had no cache for it, the entire
   * multi-megabyte transcript had to be read fresh, and past about 196 KB of fresh prompt the
   * endpoint silently discarded the front of it. From a caller that looks like a working
   * conversation answered as though it had just been opened - "Hi, how can I help you today?" in
   * the middle of a task.
   *
   * So the id is resolved against the conversations this account has already had: a caller's own
   * `x-session-id` wins, a request that continues a remembered conversation reuses that
   * conversation's id, and anything else gets the id derived from its opening. What is remembered
   * is one digest per message, never the text - `deepai/sessions.js` explains it, and nothing
   * from that table is sent upstream or injected into a prompt.
   *
   * `covered` is the part of this prompt that conversation has already sent, which the endpoint
   * should have cached; the digest is taken from the messages as forwarded, so it describes what
   * the endpoint actually saw rather than what arrived before an image was replaced by a note.
   */
  const session = resolveSession(db, {
    owner,
    messages,
    tools: body.tools,
    callerSessionId: req.get('x-session-id'),
  });
  const sessionId = session.sessionId;
  /* The caller's transcript, kept for the session row even if this request is shortened below. */
  const sessionMessages = messages;

  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  const log = options.logRequests !== false
    ? (options.log ?? ((message) => console.log(`[deepai-gateway] ${message}`)))
    : undefined;
  const startedAt = Date.now();

  /*
   * What the endpoint has to read FRESH for this request, built and measured before anything is
   * sent.
   *
   * Past about 196 KB of fresh prompt DeepAI does not refuse the request: it answers from whatever
   * part of it kept - usually the tail - with a normal 200. A caller sees a model that has
   * "forgotten" the start of a working conversation and greeted it again, which is the report this
   * guard exists for. Nothing in the answer says it happened, so the only place it can be caught
   * is before the request leaves, and only by measuring the exact bytes that will leave.
   *
   * A warm conversation is not measured by its size: once the prefix is cached, the endpoint reads
   * only the new tail, and a conversation of many megabytes costs it a few hundred tokens. So only
   * the fresh part is counted - the whole body on a cold conversation, which is what the budget
   * has always measured.
   */
  const promptBudgetBytes = Number.isInteger(options.promptBudgetBytes) && options.promptBudgetBytes > 0
    ? options.promptBudgetBytes
    : PROMPT_BUDGET_BYTES;

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
  let upstreamBytes = upstreamBodyBytes(params, usesResponses);
  /*
   * Only a tail this request actually shares counts as cached.
   *
   * `resolveSession` can hand back a remembered row for the session id alone - the fallback id is
   * derived from the first few thousand characters, so two conversations that open identically get
   * the same id - and treating that row as cached would measure the fresh part as whatever follows
   * the one message they happen to have in common. `reused` is the answer to "does this request
   * share a message with that row", and when it is false nothing is known to be cached, so the
   * whole prompt is fresh. Over-counting fresh only shortens a request that might have fit;
   * under-counting fresh is the silent truncation this guard exists to prevent.
   */
  let covered = session.reused ? session.covered : [];
  let freshBytes = freshBodyBytes(params, messages, covered, usesResponses);
  /*
   * Over the fresh budget, the conversation is compacted before it is sent.
   *
   * A refusal would be honest but useless to an agent already in the middle of a turn: the
   * harness compacts on its own schedule, measured against the 320,000-token window the catalog
   * declares, and that schedule is several times larger than the fresh body this endpoint
   * actually reads. Waiting for it is how a 437 KB transcript reached DeepAI cold and came back
   * knowing only its last 6,779 tokens.
   *
   * So the oldest turns after the goal are summarized here, with a free model, and the recent
   * work is kept verbatim. The compacted prompt is a new prefix, so nothing of the old one can
   * be treated as cached: `covered` is cleared and the whole new body is measured again. It is
   * well under the wall, which is what makes the next turns warm again.
   */
  let trimNote = '';
  if (freshBytes > promptBudgetBytes) {
    const before = promptShape(messages);
    const compacted = await fitPrompt(messages, {
      measure: (list) => upstreamBodyBytes({ ...params, messages: list }, usesResponses),
      budgetBytes: promptBudgetBytes,
      apiKey: account.apiKey,
      model: freeCompactionModel(models),
      sessionId,
      conversation: sessionId,
      signal: controller.signal,
      log,
    });
    messages = compacted.messages;
    params.messages = messages;
    covered = [];
    upstreamBytes = upstreamBodyBytes(params, usesResponses);
    freshBytes = freshBodyBytes(params, messages, covered, usesResponses);
    const parts = [];
    if (compacted.trimmed.compacted > 0) parts.push("compact" + compacted.trimmed.compacted);
    if (compacted.trimmed.dropped > 0) parts.push("drop" + compacted.trimmed.dropped);
    if (compacted.trimmed.cut > 0) parts.push("cut" + compacted.trimmed.cut);
    trimNote = parts.join("+");
    log?.("v1 " + upstreamModel + " compacted: " + before.bytes + "B -> " + promptShape(messages).bytes
      + "B fresh=" + freshBytes + "B budget=" + promptBudgetBytes + "B (" + (trimNote || "no change") + ") "
      + "session=" + sessionId.slice(0, 8));
  }

  /*
   * The same facts on the wire, for a caller that never reads a log.
   *
   * `sent` and `received` are the prompt text in bytes - what leaves and what arrived. `body` is
   * the whole serialized upstream request, tools and framing included. `fresh` is the part of it
   * the endpoint has to read rather than serve from its prompt cache - on a cold conversation the
   * whole body, on a warm one just the messages after the covered tail - and it is the number the
   * budget is measured against. `window` is the token window
   * DeepAI declares, `budget` that window in characters, `wall` and `budget-bytes` the measured
   * wall and the byte budget enforced below, and `reused` says whether this request continued a
   * session the endpoint should already have cached. A client cannot learn any of this from
   * DeepAI, whose answer to a prompt past the wall is a normal 200.
   *
   * Set after compaction, so it describes what actually leaves rather than what arrived; the
   * fallback refusal below carries the same numbers. `trim` is `none` unless a compaction ran,
   * then `compact<n>` / `drop<n>` / `cut<n>`. Semicolon-separated `key=value`, as it always was.
   */
  res.setHeader('x-gateway-prompt', [
    `sent=${promptShape(messages).bytes}`,
    `received=${arrived.bytes}`,
    `body=${upstreamBytes}`,
    `fresh=${freshBytes}`,
    `window=${CONTEXT_WINDOW_TOKENS}`,
    `budget=${PROMPT_BUDGET_CHARS}`,
    `wall=${PROMPT_WALL_BYTES}`,
    `budget-bytes=${promptBudgetBytes}`,
    `reused=${session.reused ? 'yes' : 'no'}`,
    `trim=${trimNote === '' ? 'none' : trimNote}`,
  ].join('; '));

  /*
   * The fallback: if compaction could not bring a fresh prompt under the budget, it is refused
   * rather than sent to be silently truncated.
   *
   * The refusal is OpenAI's own shape - 400 with `code: "context_length_exceeded"` - because that
   * is the error every agent harness already recognises. In practice it is unreachable: `fitPrompt`
   * cuts and drops until the body fits, and only a prompt whose current turn alone is larger than
   * the whole budget gets here. A warm conversation of any total size is not measured this way:
   * its prefix is in the endpoint's prompt cache, so only the tail is counted.
   */
  if (freshBytes > promptBudgetBytes) {
    const freshText = freshBytes.toLocaleString('en-US');
    const budget = promptBudgetBytes.toLocaleString('en-US');
    const wall = PROMPT_WALL_BYTES.toLocaleString('en-US');
    log?.(`v1 ${upstreamModel} refused after compaction: ${freshBytes}B of fresh prompt over the `
      + `${promptBudgetBytes}B fresh budget (the endpoint discards the front of a fresh prompt past `
      + `about ${PROMPT_WALL_BYTES}B) session=${sessionId.slice(0, 8)} trimmed=${trimNote || 'none'} `
      + transcriptShape(body.messages));
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
      errorCode: 'context_length_exceeded',
    });
    return apiError(
      res,
      400,
      `This request asks DeepAI to read ${freshText} bytes of prompt fresh even after the gateway `
        + `compacted it, and this gateway sends at most ${budget} bytes fresh: past about ${wall} bytes `
        + `the endpoint silently discards the start of a fresh prompt and answers from what it kept. `
        + `The current turn alone is larger than the budget, so compacting the conversation cannot `
        + `help; the x-gateway-prompt header on this refusal carries the numbers.`,
      'context_length_exceeded',
    );
  }

  const imageNote = imageCount === 0
    ? 'images=0'
    : !catalogAcceptsImages
      ? `images=${imageCount} dropped:catalog`
      : recentlyRefused
        ? `images=${imageCount} dropped:refused-recently`
        : `images=${imageCount} sent`;

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
  let firstEventMs;
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
        if (firstEventMs === undefined) firstEventMs = Date.now() - startedAt;
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
     * The retry carries different messages, so its fresh part is measured too.
     *
     * Stripping an image normally shrinks the request - a data URL is replaced by a short note -
     * but the note is a fixed length and a small enough image is shorter than it, so the retry can
     * be a few dozen bytes larger per image than the part that was checked. At the default budget
     * that cannot reach the wall, and an operator who raises `PROMPT_BUDGET_BYTES` towards it must
     * not lose the one invariant this guard exists for: nothing unmeasured goes upstream.
     */
    const retryMessages = withoutImages(body.messages);
    const retryParams = { ...params, messages: retryMessages };
    const retryBytes = freshBodyBytes(retryParams, retryMessages, covered, usesResponses);
    if (retryBytes > promptBudgetBytes) {
      status = 400;
      errorCode = 'context_length_exceeded';
      failure = new UpstreamError(
        `The text-only retry after the image refusal would ask DeepAI to read `
          + `${retryBytes.toLocaleString('en-US')} bytes of prompt fresh, over this gateway's `
          + `${promptBudgetBytes.toLocaleString('en-US')}-byte fresh budget. `
          + 'Send the question without the image, or compact the conversation and retry.',
        'CONTEXT_LENGTH_EXCEEDED',
        { status: 400 },
      );
    } else {
      text.length = 0;
      reasoning.length = 0;
      calls.clear();
      usage = undefined;
      finish = 'stop';
      firstEventMs = undefined;
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

  if (status === 200 && streamed) {
    write({}, openAIFinish(effectiveFinish));
    const finalUsage = usage ?? estimateUsage(body.messages, text, reasoning);
    res.write(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model: upstreamModel,
      choices: [],
      usage: openAIUsage(finalUsage),
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } else if (status === 200) {
    // Nothing has been written yet, so the whole split can still ride on the answer.
    const timing = [`gwcatalog;dur=${catalogMs}`];
    if (firstTokenMs !== undefined) timing.push(`gwmodel;dur=${firstTokenMs}`);
    res.setHeader('server-timing', timing.join(', '));
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
      usage: openAIUsage(usage ?? estimateUsage(body.messages, text, reasoning)),
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

  /*
   * What the effort setting did, as opposed to what it asked for.
   *
   * Measured on the free models and on the paid ones: DeepAI accepts `reasoning_effort` and
   * ignores it. A request sent with `none` still comes back with a hundred-odd reasoning tokens,
   * every shape of "off" the API can express was tried, and no value is ever refused - `banana`
   * and `999` are answered like `high`. So the log says both halves: what was asked for, and what
   * came back. A line reading `effort=none reasoning=127` is not a bug report about this gateway.
   */
  /*
   * How fast the model talked, measured the way a caller would measure it: the tokens that came
   * back over the time it took to produce them, starting from the first one.
   *
   * Both halves are on the same line as the request's own timings, so a caller comparing "the app
   * feels twice as fast" with this gateway has something to compare: a rate per request, for the
   * same model and the same prompt, instead of an impression. Reasoning tokens are excluded on
   * purpose - they are not what the reader sees arrive - and counted separately, which is why the
   * two can differ by a factor of two on a model that thinks.
   */
  const generationMs = firstTokenMs === undefined
    ? 0
    : Math.max(1, Date.now() - startedAt - firstTokenMs);
  const outputTokens = usage?.outputTokens ?? 0;
  const speedNote = generationMs > 0 && outputTokens > 0
    ? `speed=${(outputTokens / (generationMs / 1000)).toFixed(1)}tok/s `
    : '';

  const askedEffort = effortOf(requestedEffort(body));
  const effortNote = askedEffort === undefined && (usage?.reasoningTokens ?? 0) === 0
    ? ' '
    : `effort=${askedEffort ?? 'unset'} reasoning=${usage?.reasoningTokens ?? 0} `;

  /*
   * Where the time went, on one line.
   *
   * The three numbers answer the only question a slow request raises: the catalog read
   * (this gateway's own work), the wait for DeepAI to accept the call, and the wait for its
   * first token (the model's work). Reading them together is what tells a gateway problem
   * from a slow model instead of guessing at both.
   */
  log?.(`v1 chat/completions ${upstreamModel} stream=${streamed ? 'yes' : 'no'} status=${status} `
    + `catalog=${catalogMs}ms `
    + `first-event=${firstEventMs ?? '-'}ms first-token=${firstTokenMs ?? '-'}ms `
    + `total=${Date.now() - startedAt}ms${waitedMs > 0 ? ` waited=${waitedMs}ms` : ''} `
    + `prompt ${arrived.count}msg/${arrived.chars}ch/${arrived.bytes}B in, `
    + `${forwarded.count}msg/${forwarded.chars}ch/${forwarded.bytes}B out `
    + `fresh=${freshBytes}B reused=${session.reused ? 'yes' : 'no'} `
    + `session=${sessionId.slice(0, 8)} ${transcriptShape(body.messages)} `
    + `${speedNote}`
    + `${effortNote}`
    + imageNote);

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

  /*
   * Where this conversation got to, so the next turn continues it.
   *
   * Recorded after the answer, not before: the row describes what the endpoint has actually
   * received, so a request that was refused - or that failed before anything was sent - must not
   * teach it anything. Digests only; `deepai/sessions.js` says what is stored and why.
   */
  if (status === 200) {
    rememberSession(db, {
      sessionId,
      owner: req.gatewayKey.owner_username ?? '',
      keyId: req.gatewayKey.id,
      messages: sessionMessages,
      tools: body.tools,
      compacted: trimNote !== '',
    });
  }

  /*
   * The one failure this gateway cannot prevent, made visible instead.
   *
   * Every path through this handler keeps a *fresh* prompt under the wall, so the requests that can
   * still reach the endpoint past it are the ones where the gateway's idea of the cache was wrong:
   * an operator raised `PROMPT_BUDGET_BYTES` above the wall, or an operator-restarted server-side
   * cache expired under a conversation this gateway still believes is warm. Either way the endpoint
   * read the whole body fresh and discarded the front of it, and nothing in the answer says so. So
   * the signal is the endpoint's own accounting, not this gateway's expectation: a body past the
   * wall whose answer reports zero cached tokens. A stream that carries no usage at all is not this
   * case - the absence of the number is not a zero - and neither is a cache hit. Nothing is changed
   * and nothing is retried; an operator just gets to see it.
   */
  if (status === 200 && usage !== undefined && usage.cacheReadTokens === 0
    && upstreamBytes > PROMPT_WALL_BYTES) {
    log?.(`truncation-suspect session=${sessionId.slice(0, 8)} reused=${session.reused ? 'yes' : 'no'} `
      + `body=${upstreamBytes}B fresh=${freshBytes}B`);
  }
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
