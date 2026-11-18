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

import { createHash, randomUUID } from 'node:crypto';
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
import { streamChatCompletion, streamResponsesCompletion } from '../deepai/client.js';
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
 * How big a prompt is, in the two units that answer different questions.
 *
 * `count` is how many messages the caller sent, `chars` how much text they carry. Both are
 * counted on what arrived and again on what is forwarded, because those two numbers are the
 * only way to answer "did this gateway cut my conversation?" from the log instead of from
 * memory - and the answer has been asked for by someone whose history was arriving short.
 *
 * Nothing is decided from them: no limit, no refusal. They are written down.
 *
 * @param {unknown} messages - OpenAI-shaped messages.
 * @returns {{count: number, chars: number}}
 */
function promptShape(messages) {
  let chars = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message === null || typeof message !== 'object') continue;
    const content = message.content;
    if (typeof content === 'string') chars += content.length;
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (part === null || typeof part !== 'object') continue;
        if (typeof part.text === 'string') chars += part.text.length;
        else if (typeof part.image_url?.url === 'string') chars += part.image_url.url.length;
      }
    }
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      if (typeof call?.function?.arguments === 'string') chars += call.function.arguments.length;
    }
  }
  return { count: Array.isArray(messages) ? messages.length : 0, chars };
}

/**
 * The trimming, as a log field, and nothing at all when nothing was trimmed.
 *
 * `drop` counts messages removed from the start of the conversation, `cut` counts messages left
 * in it with their middle taken out - a tool result larger than the whole budget, or a single
 * message that alone overflows it.
 *
 * @param {{dropped: number, cut: number}} trimmed
 * @returns {string}
 */
function trimNote(trimmed) {
  const parts = [];
  if (trimmed.dropped > 0) parts.push(`drop${trimmed.dropped}`);
  if (trimmed.cut > 0) parts.push(`cut${trimmed.cut}`);
  return parts.length === 0 ? '' : `trim=${parts.join('+')} `;
}

/**
 * How much prompt DeepAI Code will actually read, in characters of message content, and how much
 * of a single tool result is worth sending.
 *
 * Measured against the live endpoint with content that cannot be compressed by a tokenizer or
 * served from a prompt cache (random six-letter words), so size was the only variable:
 *
 *    150,189 chars  -> 73,195 prompt tokens, and markers placed at 5%, 50% and 95% of the body
 *                       were all read back
 *    190,062 chars  -> 93,463 prompt tokens, answered
 *    200,111 chars  -> the completion came back empty; DeepAI reported no usage at all
 *    200,062 chars  -> 291 prompt tokens, the model answered as though nothing had been sent
 *    300,142 chars  -> 246 prompt tokens, "I haven't been shown any file in this conversation"
 *    600,189 chars  -> 216 prompt tokens, "No long text was provided"
 *
 * Splitting an oversized prompt does not help: 200,000 characters cut into three messages still
 * came back empty, and a 300,000-character tool result split into four tool messages for the
 * same call was dropped as well. The wall is the size of the prompt, not of a message.
 *
 * So the largest prompt verified to arrive whole is about 150,000 characters - 73,000 tokens of
 * incompressible text, closer to 36,000 of ordinary prose - well under the 320,000 the catalog
 * advertises. Past it DeepAI does not refuse; it answers as though the conversation were empty,
 * which is the "Hi, how can I help you today?" a harness gets in the middle of a task.
 *
 * The answer is therefore to shorten the prompt here, the way the app does, rather than forward
 * one that will be thrown away: a tool result longer than the budget is cut in the middle with a
 * note saying how much was left out, and if the conversation is still too long, its oldest turns
 * are dropped until it fits - the system prompt and the newest turn always survive, because they
 * are the ones being worked on.
 */
const PROMPT_BUDGET_CHARS = 150_000;

/** One tool result keeps its start and its end, and says what it lost in between. */
const TOOL_RESULT_CHARS = 50_000;

/** And so does one message that is not a tool result: a pasted file, a whole test log. */
const MESSAGE_CHARS = 40_000;

/**
 * Room kept aside for the sentence that tells the model its conversation was shortened.
 *
 * Cut to exactly the budget and then annotated, the note itself would push the prompt back over
 * it - the note is part of the prompt like anything else.
 */
const NOTE_RESERVE_CHARS = 400;

/**
 * Cut the middle out of text that is too long, and say so where the cut is.
 *
 * The middle rather than the tail: a file read is most useful at its start, a build log at its
 * end, and a model reading either needs to know that something was removed rather than silently
 * believing it has the whole thing.
 *
 * The result is at most `keep` characters, note included - a budget that is only respected after
 * the note is appended is not a budget.
 *
 * @param {string} text
 * @param {number} keep
 * @returns {string}
 */
function middleCut(text, keep) {
  if (text.length <= keep) return text;
  const note = (omitted) => `\n\n[gateway: ${omitted.toLocaleString('en-US')} characters omitted here - `
    + `DeepAI Code reads about ${PROMPT_BUDGET_CHARS.toLocaleString('en-US')} characters of prompt per request]\n\n`;
  // The note's own length depends on how many digits the omitted count has, so it is measured
  // twice: once to make room for itself, once for the count the final text will report.
  let room = Math.max(2, keep - note(text.length).length);
  let fitted = Math.max(2, keep - note(text.length - room).length);
  if (fitted !== room) {
    room = fitted;
    fitted = Math.max(2, keep - note(text.length - room).length);
  }
  const head = Math.max(1, Math.floor(fitted / 2));
  const tail = Math.max(1, fitted - head);
  return `${text.slice(0, head)}${note(text.length - head - tail)}${text.slice(-tail)}`;
}

/**
 * Group messages so a tool call and its results are dropped together.
 *
 * Dropped separately they leave a tool result whose call is gone, or a call whose results are
 * gone - and measured, DeepAI drops a request whose transcript has an unpaired tool result
 * entirely, which would be a far worse failure than the one being fixed.
 *
 * @param {Array<object>} messages
 * @returns {Array<Array<object>>}
 */
function promptUnits(messages) {
  const units = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    const ids = new Set((Array.isArray(message?.tool_calls) ? message.tool_calls : [])
      .map((call) => call?.id)
      .filter((id) => typeof id === 'string'));
    const unit = [message];
    index += 1;
    if (ids.size > 0) {
      while (index < messages.length && messages[index]?.role === 'tool' && ids.has(messages[index]?.tool_call_id)) {
        unit.push(messages[index]);
        index += 1;
      }
    }
    units.push(unit);
  }
  return units;
}

/**
 * Shorten a conversation until DeepAI will read all of it.
 *
 * Reported in the log and marked in the transcript, because a model that is handed a shortened
 * conversation has to know it is looking at one.
 *
 * @param {unknown} messages
 * @returns {{messages: Array<object>, trimmed: {dropped: number, cut: number}}}
 */
function fitPrompt(messages) {
  const trimmed = { dropped: 0, cut: 0 };
  /** What one message may keep: a tool result has more room than a message because it is output. */
  const allowance = (message) => (message?.role === 'tool' ? TOOL_RESULT_CHARS : MESSAGE_CHARS);
  /*
   * Nothing is touched while the prompt fits: a message is only worth shortening when the whole
   * prompt is over the line, and a 120,000-character tool result that DeepAI reads without
   * complaint should be read without complaint.
   */
  // The system prompt is the standing instruction, never a turn to be dropped.
  const head = [];
  let rest = Array.isArray(messages) ? messages : [];
  while (rest.length > 0 && rest[0]?.role === 'system') {
    head.push(rest[0]);
    rest = rest.slice(1);
  }
  let units = promptUnits(rest);

  const room = PROMPT_BUDGET_CHARS - NOTE_RESERVE_CHARS;
  const flat = () => units.flat();
  const size = () => promptShape([...head, ...flat()]).chars;
  const largest = () => {
    let found = null;
    for (const message of [...head, ...flat()]) {
      if (typeof message?.content !== 'string') continue;
      if (found === null || message.content.length > found.content.length) found = message;
    }
    return found;
  };

  /*
   * Three ways to make room, tried in the order that loses the least.
   *
   * A message larger than one message is allowed to be is cut down to that size first - it holds
   * something worth reading, and it is the reason the prompt is over the line. Whole turns are
   * dropped only when every message is already a reasonable size, because then what is over the
   * line is how many turns there are, not what any one of them says. Cutting a turn that a drop
   * would have removed anyway is the last resort.
   */
  for (let attempt = 0; attempt < 256 && size() > room; attempt += 1) {
    const biggest = largest();
    if (biggest !== null && biggest.content.length > allowance(biggest)) {
      const shortened = { ...biggest, content: middleCut(biggest.content, allowance(biggest)) };
      units = units.map((unit) => unit.map((message) => (message === biggest ? shortened : message)));
      if (head.includes(biggest)) head[head.indexOf(biggest)] = shortened;
      continue;
    }
    if (units.length > 1) {
      // Oldest first, never the last unit: that is where the request being worked on lives.
      trimmed.dropped += units.shift().length;
      continue;
    }
    if (biggest === null) break;
    const keep = Math.max(2_000, biggest.content.length - (size() - room));
    const shortened = { ...biggest, content: middleCut(biggest.content, keep) };
    if (shortened.content.length >= biggest.content.length) break;
    units = units.map((unit) => unit.map((message) => (message === biggest ? shortened : message)));
    if (head.includes(biggest)) head[head.indexOf(biggest)] = shortened;
  }

  let final = [...head, ...flat()];
  /*
   * Counted from the messages themselves, not from the number of passes: the loop above can meet
   * the same message twice, and a log that said "2 shortened" for one file would send a reader
   * looking for a second one.
   */
  trimmed.cut = final.filter((message) => typeof message?.content === 'string'
    && message.content.includes('characters omitted here')).length;

  if (trimmed.dropped > 0 || trimmed.cut > 0) {
    /*
     * Said once, up front, where a model reading the transcript will meet it before the turns it
     * is missing: otherwise the conversation appears to start mid-thought with no explanation.
     */
    const parts = [];
    if (trimmed.dropped > 0) parts.push(`${trimmed.dropped} earlier messages were dropped`);
    if (trimmed.cut > 0) parts.push(`${trimmed.cut} oversized messages were shortened`);
    final = [...head, {
      role: 'user',
      content: `[gateway: ${parts.join(' and ')} to fit DeepAI Code's prompt limit of about `
        + `${PROMPT_BUDGET_CHARS.toLocaleString('en-US')} characters per request]`,
    }, ...final.slice(head.length)];
  }
  return { messages: final, trimmed };
}

/**
 * The text of one message, for hashing and for counting.
 *
 * @param {unknown} message
 * @returns {string}
 */
function messageText(message) {
  if (message === null || typeof message !== 'object') return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (part !== null && typeof part === 'object' && typeof part.text === 'string') text += part.text;
  }
  return text;
}

/**
 * A stable id for one conversation, derived from how it begins.
 *
 * The system prompt and the first user message are what every turn of a conversation carries
 * unchanged, so hashing them gives an id that is the same on turn 1 and turn 40 and different
 * from another conversation's. Only the first few thousand characters are hashed: enough to
 * tell conversations apart, little enough that the hash costs nothing on a long prompt.
 *
 * @param {unknown} messages
 * @returns {string} 32 hex characters, the shape DeepAI's own session ids have.
 */
function conversationId(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const system = list.find((message) => message?.role === 'system' || message?.role === 'developer');
  const firstUser = list.find((message) => message?.role === 'user');
  const seed = `${messageText(system).slice(0, 4096)}\u0000${messageText(firstUser).slice(0, 4096)}`;
  return createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 32);
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

/** Characters per token for the fixed-density heuristic (matches DSH token-meter). */
const CHARS_PER_TOKEN = 4;
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
          context_window: model.contextWindow,
          max_output_tokens: model.maxTokens,
          api: model.api,
          /*
           * The catalog's per-request figure, and what a request actually costs.
           *
           * The first is DeepAI's own number and it is a ceiling: measured, a real MiniMax M3
           * request cost 0.0082 Credits against a catalog figure of 2. The second is where the
           * equation puts that tier, in two units: per minute of generation, which is what the
           * pages show as `0.60 Credits / min`, and per thousand tokens, for a caller pricing its
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
      res.json({ object: 'list', data: visible.map(publicModel) });
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
   * The session id is what DeepAI keeps a conversation's affinity on, and this gateway used to
   * send one value - the gateway key's id - for every conversation of every caller.
   *
   * That is not what the desktop app does: it sends an id of its own per conversation, and the
   * endpoint uses it for more than caching. Its own error code is `session_busy`, a `409` it
   * answers by waiting for the same session, which is only coherent if a session means one
   * conversation. Sending one id for all of them put unrelated conversations into the same
   * session, and the visible symptom was the model answering a working conversation as though
   * it had just been opened: "Hi, how can I help you today?" in the middle of a task.
   *
   * So a caller's own id still wins, and otherwise one is derived from the conversation's own
   * beginning - the system prompt and the first user message - which stays the same for every
   * turn of that conversation and differs between conversations. Two identical conversations
   * share an id, which is right: their prompts are identical anyway.
   */
  const sessionId = req.get('x-session-id') ?? conversationId(body.messages);

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
  const messages = imageCount > 0 && !imagesSupported
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
   * The same measurement on both sides of this proxy: what the caller sent, and what DeepAI is
   * given. An image can take a message out of the second one, so the two are not always equal -
   * and a log that only showed the first would hide exactly the change a reader would need to
   * explain a strange answer.
   */
  const arrived = promptShape(body.messages);
  /*
   * Shortened here rather than forwarded as it is. Above the budget DeepAI does not refuse the
   * request: it answers from an empty conversation, so the model sees nothing and says hello.
   * A conversation cut down to fit is worse than the whole one and much better than nothing -
   * and the log records the difference, so a shortened turn is never a mystery.
   */
  const { messages: sentMessages, trimmed } = fitPrompt(messages);
  const forwarded = promptShape(sentMessages);

  const imageNote = imageCount === 0
    ? 'images=0'
    : !catalogAcceptsImages
      ? `images=${imageCount} dropped:catalog`
      : recentlyRefused
        ? `images=${imageCount} dropped:refused-recently`
        : `images=${imageCount} sent`;

  const params = {
    apiKey: account.apiKey,
    model: upstreamModel,
    messages: sentMessages,
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

  const log = options.logRequests !== false
    ? (options.log ?? ((message) => console.log(`[deepai-gateway] ${message}`)))
    : undefined;

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
      await runAttempt({ ...params, messages: fitPrompt(withoutImages(body.messages)).messages });
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
    + `catalog=${catalogMs}ms first-event=${firstEventMs ?? '-'}ms first-token=${firstTokenMs ?? '-'}ms `
    + `total=${Date.now() - startedAt}ms${waitedMs > 0 ? ` waited=${waitedMs}ms` : ''} `
    + `prompt ${arrived.count}msg/${arrived.chars}ch in, ${forwarded.count}msg/${forwarded.chars}ch out `
    + `session=${sessionId.slice(0, 8)} ${transcriptShape(body.messages)} `
    + `${trimNote(trimmed)}`
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
