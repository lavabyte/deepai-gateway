/**
 * Make a prompt fit the budget the model's catalog entry gives it.
 *
 * There is no fixed byte wall here. A model's budget comes from its own `contextWindow` and
 * `maxTokens` (see `deepai/window.js`), so a catalog change moves the budget without a code
 * change. When the caller has set `PROMPT_BUDGET_BYTES`, that explicit operator value wins for
 * deployments that measured a tighter limit on their own endpoint.
 *
 * Three rules, in order, and only for a prompt that is already over its budget:
 *
 * 1. A single message larger than its share keeps its head and tail, with a note where the
 *    middle was. A file read is most useful at its start, a build log at its end.
 * 2. The turns between the goal and the most recent work are summarized into a checkpoint by a
 *    free model, in the same format the DeepAI Code app uses for its own compactions.
 * 3. If the checkpoint cannot be written, those turns are dropped - still with a note - so the
 *    request is served rather than refused.
 *
 * The goal at the head and the work nearest the current step are never summarized: an agent gets
 * its task once and then a thousand tool calls, and taking the oldest end first was exactly how a
 * model ended up rediscovering what it had been asked to do.
 *
 * @module deepai-gateway/deepai/fit
 */

import { compactMessages } from './compaction.js';

/*
 * These are shares of the budget, not context sizes. They decide how much of a model's own
 * window one message may keep and how much recent work survives verbatim; the budget itself is
 * always the model entry or the operator's explicit override.
 */
const NOTE_SHARE = 0.005;
const KEEP_RECENT_SHARE = 0.34;
const SUMMARY_RESERVE_SHARE = 0.09;
const TOOL_ALLOWANCE_SHARE = 0.28;
const MESSAGE_ALLOWANCE_SHARE = 0.23;

const textOf = (message) => {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (part !== null && typeof part === 'object' && typeof part.text === 'string') text += part.text;
  }
  return text;
};

/**
 * Cut the middle out of text that is too long, and say so where the cut is.
 *
 * @param {string} text
 * @param {number} keep
 * @returns {string}
 */
function middleCut(text, keep) {
  if (text.length <= keep) return text;
  const note = (omitted) => `\n\n[gateway: ${omitted.toLocaleString('en-US')} characters omitted here `
    + `to fit the model's prompt budget]\n\n`;
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
 * @param {Array<object>} messages
 * @returns {Array<Array<object>>}
 */
export function promptUnits(messages) {
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
 * The checkpoint that replaces the compacted turns, said so a model knows what it is reading.
 *
 * @param {number} count - messages replaced.
 * @param {Array<Array<object>>} removed - the units that were summarized.
 * @param {string} summary - what the model wrote.
 * @returns {object} an OpenAI message.
 */
function checkpointMessage(count, removed, summary) {
  const bytes = Buffer.byteLength(JSON.stringify(removed.flat()), 'utf8');
  return {
    role: 'user',
    content: `[gateway: ${count} earlier messages (${bytes.toLocaleString('en-US')} bytes) were `
      + `compacted into the checkpoint below - they were not dropped. The part of this conversation `
      + `that no longer fits the model's prompt budget was summarized by the model itself, in the same `
      + `format the DeepAI Code app uses for its own compactions. Treat the checkpoint as the history `
      + `of the work already done.]\n\n${summary}`,
  };
}

/**
 * Ask the model for a checkpoint of the turns a compaction is about to remove.
 *
 * @param {{apiKey?: string, model?: string, sessionId?: string, conversation?: string, signal?: AbortSignal, log?: (message: string) => void}} context
 * @param {Array<Array<object>>} units
 * @returns {Promise<string|undefined>}
 */
async function checkpointFor(context, units) {
  if (typeof context.apiKey !== 'string' || context.apiKey === ''
    || typeof context.conversation !== 'string' || context.conversation === '') {
    return undefined;
  }
  if (typeof context.model !== 'string' || context.model === '') {
    context.log?.('compaction skipped: the catalog lists no free model to summarize with, so the turns are dropped');
    return undefined;
  }
  try {
    const { summary } = await compactMessages({
      apiKey: context.apiKey,
      model: context.model,
      sessionId: context.sessionId,
      conversation: context.conversation,
      units,
      signal: context.signal,
    });
    return summary === '' ? undefined : summary;
  } catch (error) {
    if (context.signal?.aborted) throw error;
    context.log?.(`compaction failed, dropping instead: ${error?.message ?? error}`);
    return undefined;
  }
}

/**
 * Shorten a conversation until the fresh part DeepAI has to read fits its budget.
 *
 * @param {Array<object>} messages - OpenAI-shaped messages.
 * @param {object} options
 * @param {(messages: Array<object>) => number} options.measure - exact serialized body bytes.
 * @param {number} [options.budgetBytes] - the fresh byte budget.
 * @param {string} [options.apiKey] - the account that pays for the free summary call.
 * @param {string} [options.model] - the free summarizer model.
 * @param {string} [options.sessionId] - the conversation's session id, for the summary call.
 * @param {string} [options.conversation] - stable id for the compaction cache.
 * @param {AbortSignal} [options.signal]
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<{messages: Array<object>, trimmed: {compacted: number, dropped: number, cut: number}}>}
 */
export async function fitPrompt(messages, options = {}) {
  const trimmed = { compacted: 0, dropped: 0, cut: 0 };
  const measure = typeof options.measure === 'function'
    ? options.measure
    : (list) => Buffer.byteLength(JSON.stringify(list), 'utf8');
  /*
   * No local default. Without a catalog window or an operator override there is no number this
   * gateway can honestly call the model's budget, so it forwards the prompt as the caller wrote
   * it instead of inventing one.
   */
  const budgetBytes = Number.isInteger(options.budgetBytes) && options.budgetBytes > 0
    ? options.budgetBytes
    : undefined;
  if (budgetBytes === undefined) {
    return {
      messages: Array.isArray(messages) ? [...messages] : [],
      trimmed,
    };
  }

  const noteReserve = Math.max(1, Math.floor(budgetBytes * NOTE_SHARE));
  const room = Math.max(1, budgetBytes - noteReserve);
  const keepRecentBytes = Math.max(1, Math.floor(room * KEEP_RECENT_SHARE));
  const summaryReserveBytes = Math.max(1, Math.floor(room * SUMMARY_RESERVE_SHARE));
  const target = Math.min(room, keepRecentBytes + summaryReserveBytes);

  /** What one message may keep, as a share of this model's budget. */
  const allowance = (message) => Math.max(1, Math.floor(room
    * (message?.role === 'tool' ? TOOL_ALLOWANCE_SHARE : MESSAGE_ALLOWANCE_SHARE)));

  // The system prompt is the standing instruction, never a turn to be dropped.
  const head = [];
  let rest = Array.isArray(messages) ? messages : [];
  while (rest.length > 0 && rest[0]?.role === 'system') {
    head.push(rest[0]);
    rest = rest.slice(1);
  }
  let units = promptUnits(rest);
  /** The unit that carries the checkpoint, if a compaction happened: never dropped again. */
  let checkpointUnit = null;

  const unitBytes = (unit) => Buffer.byteLength(JSON.stringify(unit), 'utf8');
  const size = () => measure([...head, ...units.flat()]);
  const largest = () => {
    let found = null;
    for (const message of [...head, ...units.flat()]) {
      if (typeof message?.content !== 'string') continue;
      if (found === null || message.content.length > found.content.length) found = message;
    }
    return found;
  };
  const replace = (message, content) => {
    const shortened = { ...message, content };
    if (head.includes(message)) head[head.indexOf(message)] = shortened;
    else units = units.map((unit) => unit.map((item) => (item === message ? shortened : item)));
  };

  /**
   * Where the recent work starts: enough of the newest turns to fill the keep-recent allowance.
   * The first unit is the goal, so the scan stops at index 1.
   */
  const recentStart = () => {
    let total = 0;
    let start = Math.max(0, units.length - 1);
    for (let index = units.length - 1; index >= 1; index -= 1) {
      total += unitBytes(units[index]);
      start = index;
      if (total >= keepRecentBytes) break;
    }
    return start;
  };

  /*
   * First rule: a message larger than a message is allowed to be loses its middle. It holds
   * something worth reading - a file, a build log - and it is usually the reason the prompt is
   * over the line, so it is shortened before anything is taken out of the conversation.
   */
  for (let attempt = 0; attempt < 64 && size() > room; attempt += 1) {
    const biggest = largest();
    if (biggest === null || biggest.content.length <= allowance(biggest)) break;
    replace(biggest, middleCut(biggest.content, allowance(biggest)));
  }

  /*
   * Second rule: the turns in the middle are compacted, not dropped. The oldest units after the
   * goal go first, and only until the prompt is small enough that the next few turns fit before
   * another compaction is needed.
   */
  if (size() > room && units.length > 2) {
    const pinnedFrom = recentStart();
    const victims = [];
    let projected = size();
    for (let index = 1; index < pinnedFrom && projected > target; index += 1) {
      victims.push(index);
      projected -= unitBytes(units[index]);
    }
    if (victims.length > 0) {
      const removed = victims.map((index) => units[index]);
      const count = removed.reduce((sum, unit) => sum + unit.length, 0);
      const checkpoint = await checkpointFor(options, removed);
      const first = victims[0];
      const last = victims[victims.length - 1];
      if (checkpoint !== undefined) {
        checkpointUnit = [checkpointMessage(count, removed, checkpoint)];
        units = [
          ...units.slice(0, first),
          checkpointUnit,
          ...units.slice(last + 1),
        ];
        trimmed.compacted = count;
      } else {
        units = units.filter((_, index) => !victims.includes(index));
        trimmed.dropped += count;
      }
    }
  }

  /*
   * Third rule, and the last resort: if a single message still overflows the budget, cut it to
   * fit. The overflow is counted in bytes and the cut in characters, so the two are converted
   * through this message's own density.
   */
  for (let attempt = 0; attempt < 64 && size() > room; attempt += 1) {
    const biggest = largest();
    if (biggest === null) break;
    const density = Math.max(1, Buffer.byteLength(biggest.content, 'utf8') / Math.max(1, biggest.content.length));
    const keep = Math.max(2_000, biggest.content.length - Math.ceil((size() - room) / density));
    if (keep >= biggest.content.length) break;
    replace(biggest, middleCut(biggest.content, keep));
  }

  /*
   * And if whole turns are still what overflows it, the middle goes - the checkpoint was too
   * large, or there was no droppable turn left to summarize. The checkpoint itself is never one
   * of them: it is what the removed turns were reduced to, and dropping it would lose them twice.
   */
  while (size() > room && units.length > 2) {
    const pinnedFrom = Math.max(1, recentStart());
    const victim = units.findIndex((unit, index) => index >= 1 && index < pinnedFrom && unit !== checkpointUnit);
    if (victim < 0) break;
    trimmed.dropped += units.splice(victim, 1)[0].length;
  }

  let final = [...head, ...units.flat()];
  trimmed.cut = final.filter((message) => typeof message?.content === 'string'
    && message.content.includes('characters omitted here')).length;

  if (trimmed.dropped > 0 || trimmed.cut > 0) {
    const parts = [];
    if (trimmed.dropped > 0) parts.push(`${trimmed.dropped} earlier messages were dropped`);
    if (trimmed.cut > 0) parts.push(`${trimmed.cut} oversized messages were shortened`);
    final = [...head, {
      role: 'user',
      content: `[gateway: ${parts.join(' and ')} to fit the model's prompt budget]`,
    }, ...final.slice(head.length)];
  }
  return { messages: final, trimmed };
}
