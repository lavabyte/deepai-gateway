/**
 * Conversation compaction, the way the DeepAI Code app does it.
 *
 * The app does not hand a growing conversation to DeepAI until it overflows: the harness behind it
 * measures the context, and when it is nearly full it asks the model for a structured checkpoint
 * summary of everything older than the last few turns, replaces that part of the transcript with
 * the summary, and continues. Its prompts live in `dist/core/compaction/compaction.js` of the
 * bundled `@earendil-works/pi-coding-agent`, and the two prompts below are copied from there
 * verbatim, because a summary written for one reader is not the same as a summary written for
 * another: the app's format - goal, constraints, progress, decisions, next steps, critical
 * context - is what a model needs in order to continue someone else's work.
 *
 * This gateway cannot replace the caller's history: the caller sends its whole transcript on every
 * turn, and that is the contract of an OpenAI-compatible endpoint. What it can do is what the app
 * does *before* DeepAI sees the prompt - summarize the part that would not fit and forward the
 * summary in its place - so the model is handed a checkpoint of the dropped work instead of a
 * transcript that quietly starts in the middle. That is the difference between an agent that
 * forgets and an agent that remembers less precisely.
 *
 * The summary is written with a free model chosen from the catalog, never with the model the caller
 * asked for: keeping a conversation costs the gateway a call, and that call is not the caller's
 * bill.
 *
 * Summaries are cached per conversation and extended incrementally: the dropped range always
 * starts at the same place and only grows at its end, so the next compaction only has to summarize
 * the messages that were not in the previous summary, merging them with the checkpoint the update
 * prompt expects.
 *
 * @module deepai-gateway/deepai/compaction
 */

import { createHash } from 'node:crypto';
import { streamChatCompletion } from './client.js';
import { UpstreamError } from './wire.js';

/**
 * The standing instruction, from the app's compaction module.
 *
 * It is deliberately not the model's own persona: the transcript is wrapped in `<conversation>`
 * tags and this tells the model to write a checkpoint rather than answer what it reads.
 */
export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

/** The first summary of a conversation, from the app. */
export const INITIAL_SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * Every later summary, also from the app: the previous checkpoint is carried forward so that a
 * conversation compacted five times does not lose what the first compaction recorded.
 */
export const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * A tool result is most useful at its start when it is summarized, and the app caps it the same
 * way: the point of a checkpoint is what happened, not a whole file.
 */
const TOOL_RESULT_CHARS = 1_500;

/** And a message that is not tool output keeps a little more of itself, for the same reason. */
const MESSAGE_CHARS = 3_000;

/**
 * How much serialized conversation one summarization request may carry.
 *
 * The same wall that makes the gateway trim applies to the summary request itself, and a summary
 * request that is thrown away upstream would return an empty answer - so a long dropped range is
 * summarized in several passes, each merged into the one before it. 90,000 bytes sits under the
 * budget with room for the prompts and for the previous summary.
 */
const SUMMARY_INPUT_BYTES = 90_000;

/** The summary is an answer like any other; a checkpoint needs a few hundred tokens, not thousands. */
const SUMMARY_MAX_TOKENS = 4_096;

/**
 * How long one summarization request may take.
 *
 * Per request, not per compaction: the first compaction of a conversation that grew for days can
 * need several passes over a range larger than one prompt may be, and a single deadline for all of
 * them would either cut the summary short or force the gateway to drop what it was trying to keep.
 * Each pass is bounded, so the whole compaction is bounded by the size of what it summarizes.
 */
const SUMMARY_TIMEOUT_MS = 90_000;

/** Two attempts is the app's own patience with a busy worker, per summary call. */
const SUMMARY_ATTEMPTS = 2;
const SUMMARY_RETRY_MS = 1_000;

/** How many conversations keep a cached summary. Each entry is one checkpoint, a few KB at most. */
const CACHE_LIMIT = 64;

/** Conversation key -> the checkpoint of everything compacted so far, and the range it covers. */
const cache = new Map();

/** Forget every cached checkpoint (tests, and a deployment that wants a clean slate). */
export function forgetCompactionCache() {
  cache.clear();
}

/** The text of one message, however OpenAI spelled its content. */
function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue;
    if (typeof part.text === 'string') text += part.text;
    else if (typeof part.image_url?.url === 'string') text += '[image]';
  }
  return text;
}

/** Keep the start of a long text and say how much was left out, as the app does. */
function truncate(text, limit) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[... ${(text.length - limit).toLocaleString('en-US')} more characters truncated]`;
}

/** One tool call, in the app's `name(key=value, ...)` shape. */
function toolCallText(call) {
  const name = typeof call?.function?.name === 'string' ? call.function.name : 'tool';
  const raw = call?.function?.arguments;
  if (typeof raw !== 'string' || raw === '') return `${name}()`;
  try {
    const args = JSON.parse(raw);
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return `${name}(${truncate(raw, 400)})`;
    return `${name}(${Object.entries(args).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(', ')})`;
  } catch {
    return `${name}(${truncate(raw, 400)})`;
  }
}

/**
 * Serialize OpenAI-shaped messages into the text the summarizer reads.
 *
 * The app's `serializeConversation` does the same thing for harness messages: the transcript is
 * rendered as text so the model summarizes it instead of continuing it, thinking is left out, and
 * tool output is shortened. Roles are prefixed in the app's own spelling (`[User]`, `[Assistant]`,
 * `[Assistant tool calls]`, `[Tool result]`).
 *
 * @param {Array<object>} messages
 * @returns {string}
 */
export function serializeConversation(messages) {
  const parts = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message === null || typeof message !== 'object') continue;
    const role = typeof message.role === 'string' ? message.role : 'unknown';
    const text = messageText(message);
    if (role === 'user' || role === 'system' || role === 'developer') {
      if (text !== '') parts.push(`[${role === 'user' ? 'User' : 'System'}]: ${truncate(text, MESSAGE_CHARS)}`);
    } else if (role === 'assistant') {
      if (text !== '') parts.push(`[Assistant]: ${truncate(text, MESSAGE_CHARS)}`);
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (calls.length > 0) {
        parts.push(`[Assistant tool calls]: ${calls.map(toolCallText).join('; ')}`);
      }
    } else if (role === 'tool') {
      if (text !== '') parts.push(`[Tool result]: ${truncate(text, TOOL_RESULT_CHARS)}`);
    } else if (text !== '') {
      parts.push(`[${role}]: ${truncate(text, MESSAGE_CHARS)}`);
    }
  }
  return parts.join('\n\n');
}

/**
 * A stable hash of one compaction unit.
 *
 * The unit, not the message, because a tool call and its results are dropped together - and the
 * cached summary covers a whole number of units, so the hashes are what tells this turn's dropped
 * range apart from the previous one's.
 *
 * The whole message is hashed, not the shortened text the summarizer reads: two tool results that
 * start the same way are not the same result, and a checkpoint that covered one of them must not be
 * reused for the other.
 *
 * @param {Array<object>} unit
 * @returns {string}
 */
export function unitFingerprint(unit) {
  const hash = createHash('sha256');
  for (const message of unit) {
    hash.update(JSON.stringify({
      role: message?.role,
      content: message?.content,
      tool_calls: message?.tool_calls,
      tool_call_id: message?.tool_call_id,
    }) ?? '');
    hash.update('\u0000');
  }
  return hash.digest('hex');
}

/** The hash of the first `count` unit fingerprints: the range a cached summary covers. */
function prefixFingerprint(fingerprints, count = fingerprints.length) {
  const hash = createHash('sha256');
  for (let index = 0; index < count; index += 1) hash.update(fingerprints[index]);
  return hash.digest('hex');
}

/** Split units into groups whose serialized text fits one summarization request. */
function groupsToSummarize(units) {
  const groups = [];
  let current = [];
  let bytes = 0;
  for (const unit of units) {
    const text = serializeConversation(unit);
    const size = Buffer.byteLength(text, 'utf8') + 2;
    if (current.length > 0 && bytes + size > SUMMARY_INPUT_BYTES) {
      groups.push(current);
      current = [];
      bytes = 0;
    }
    current.push(text);
    bytes += size;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** Wait, unless the caller goes away first. */
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new UpstreamError('request aborted', 'ABORTED'));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      reject(new UpstreamError('request aborted', 'ABORTED'));
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** One summarization turn for one group of messages. */
async function summarizeGroup({ apiKey, model, sessionId, conversationText, previous, signal }) {
  const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`
    + (previous === '' ? '' : `<previous-summary>\n${previous}\n</previous-summary>\n\n`)
    + (previous === '' ? INITIAL_SUMMARIZATION_PROMPT : UPDATE_SUMMARIZATION_PROMPT);

  const request = {
    apiKey,
    model,
    messages: [
      { role: 'system', content: SUMMARIZATION_SYSTEM_PROMPT },
      { role: 'user', content: promptText },
    ],
    maxTokens: SUMMARY_MAX_TOKENS,
    /*
     * A checkpoint is written from what is in the transcript, so there is nothing to think about.
     * `none` is what the app sends when its thinking level is off, and DeepAI ignores the field
     * either way - it is here so a summarization request is never the expensive one.
     */
    reasoningEffort: 'none',
    sessionId,
    /*
     * One pass has its own deadline, so a hung upstream cannot hold a caller's turn open forever,
     * while a long compaction made of several passes still finishes.
     */
    signal: signal === undefined
      ? AbortSignal.timeout(SUMMARY_TIMEOUT_MS)
      : AbortSignal.any([signal, AbortSignal.timeout(SUMMARY_TIMEOUT_MS)]),
  };

  let lastError;
  for (let attempt = 1; attempt <= SUMMARY_ATTEMPTS; attempt += 1) {
    try {
      const text = [];
      let finish = 'stop';
      for await (const event of streamChatCompletion(request)) {
        if (event.type === 'text') text.push(event.text);
        else if (event.type === 'finish') finish = event.reason ?? 'stop';
      }
      const answer = text.join('').trim();
      if (answer === '') {
        throw new UpstreamError('the summarization request returned no text', 'EMPTY_SUMMARY');
      }
      return { summary: answer, truncated: finish === 'length' };
    } catch (error) {
      lastError = error;
      const retryable = error instanceof UpstreamError
        && (error.code === 'CAPACITY' || error.code === 'RATE_LIMIT' || error.code === 'TRANSPORT');
      if (!retryable || attempt === SUMMARY_ATTEMPTS) break;
      await pause(error.providerRetryAfterMs ?? SUMMARY_RETRY_MS, signal);
    }
  }
  throw lastError;
}

/**
 * Summarize the messages a compaction is about to remove, extending a cached checkpoint when one
 * covers a prefix of the same range.
 *
 * @param {object} params
 * @param {string} params.apiKey - the DeepAI key that pays, which is the account the caller's key belongs to.
 * @param {string} params.model - a free model from the catalog: a compaction is the gateway's own work
 *   and must never add a paid call to a request that was free, or a second paid call to one that was not.
 * @param {string} params.sessionId - the conversation's session, as the app reuses it for its own summaries.
 * @param {string} params.conversation - stable id of the conversation, for the cache.
 * @param {Array<Array<object>>} params.units - whole turns being removed, in conversation order.
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{summary: string, calls: number, summarized: number}>}
 */
export async function compactMessages({ apiKey, model, sessionId, conversation, units, signal }) {
  const key = `${conversation}\u0000${model}`;
  const fingerprints = units.map(unitFingerprint);
  const cached = cache.get(key);

  let extent = 0;
  let summary = '';
  if (cached !== undefined && cached.count <= fingerprints.length
    && cached.hash === prefixFingerprint(fingerprints, cached.count)) {
    extent = cached.count;
    summary = cached.summary;
  }

  // The checkpoint already covers everything being removed: nothing to ask the model for.
  if (extent === fingerprints.length) {
    cache.delete(key);
    cache.set(key, cached);
    return { summary: summary.trim(), calls: 0, summarized: 0 };
  }

  const groups = groupsToSummarize(units.slice(extent));
  /*
   * A compaction must stop the moment the caller goes away. The deadline is per pass and lives
   * inside `summarizeGroup`; this is the caller's own signal, which is what turns a disconnect
   * into a cancelled request rather than a dropped conversation.
   */
  let calls = 0;
  for (const group of groups) {
    const produced = await summarizeGroup({
      apiKey,
      model,
      sessionId,
      conversationText: group.join('\n\n'),
      previous: summary,
      signal,
    });
    /*
     * A summary cut off at the output limit is still the most useful thing the model wrote, and the
     * next pass - or the next compaction - continues from it. The app retries a truncated summary
     * once with a smaller word budget; here the checkpoint is capped by the prompt itself, so the
     * partial text is kept and marked rather than thrown away.
     */
    summary = produced.truncated ? `${produced.summary}\n\n[summary truncated]` : produced.summary;
    calls += 1;
  }

  const hash = prefixFingerprint(fingerprints);
  cache.delete(key);
  cache.set(key, { count: fingerprints.length, hash, summary });
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);

  return { summary: summary.trim(), calls, summarized: fingerprints.length - extent };
}
