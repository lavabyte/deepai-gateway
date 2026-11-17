/**
 * How much prompt DeepAI Code actually serves, as opposed to what its catalog advertises.
 *
 * The catalog says 320,000 tokens of context for every model. Measured against the live
 * endpoint, that is not what is served: past roughly 38,500 tokens of prompt DeepAI silently
 * keeps only part of the request, and the part it drops is the beginning of the conversation.
 * Nothing in the answer says so - `finish_reason` is `stop`, there is no error, and the only
 * visible trace is a `prompt_tokens` smaller than the request that was sent.
 *
 * The measurements, `glm-5.3-flash`, uniform English prose (about 5 characters per token):
 *
 *   content sent   reported prompt_tokens   what DeepAI did
 *   160,102        34,091                  all of it
 *   180,010        38,291                  all of it
 *   190,438        38,691                  all of it
 *   200,392        38,583                  cut (7% short of what was sent)
 *   260,000        38,713                  cut (26% short)
 *   300,000        38,804                  cut (40% short)
 *
 * A single message over about 190,000 characters collapses harder: a 200,000-character message
 * arrived as 1,835 tokens. And the premier `glm-5.3` plateaus at the same 39,791 tokens as the
 * flash model for an identical 800 KB body, so this is a budget of the endpoint itself rather
 * than a property of any one model.
 *
 * What the gateway does with that: it refuses a request above the budget instead of forwarding
 * one that will be cut. A conversation quietly losing its first half is the worst of the three
 * possible answers - worse than an error, because the model then answers confidently about a
 * history it never saw. The refusal is shaped like OpenAI's own context-overflow error, which
 * is what makes a client compact the conversation and try again instead of showing the reader
 * a mystery.
 */

/**
 * The largest prompt measured to arrive whole, in characters of message content.
 *
 * 180,000 rather than 190,000: the request at 190,438 characters came back complete, but only
 * just - the cut begins somewhere between it and 200,392 - and the cost of being a little early
 * is one compaction, while the cost of being late is a silently truncated history.
 */
export const PROMPT_BUDGET_CHARS = 180_000;

/**
 * Characters per token, measured on the same prose.
 *
 * Only used to say the budget in tokens as well, which is the unit clients think in. The
 * decision itself is made on characters, which need no tokenizer and cannot be wrong about
 * what was sent.
 */
const PROMPT_CHARS_PER_TOKEN = 5;

/**
 * The size of a prompt, measured the way the budget is.
 *
 * Content only, plus a small allowance per message for the role and JSON framing. Images count
 * as their URL, which is what travels; their pixels are not prompt text.
 *
 * @param {unknown} messages - OpenAI-shaped messages.
 * @returns {{chars: number, tokens: number}}
 */
export function promptSize(messages) {
  let chars = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message === null || typeof message !== 'object') continue;
    chars += 24;
    const content = message.content;
    if (typeof content === 'string') {
      chars += content.length;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part === null || typeof part !== 'object') continue;
        if (typeof part.text === 'string') chars += part.text.length;
        else if (typeof part.image_url?.url === 'string') chars += part.image_url.url.length;
        else if (typeof part.image_url === 'string') chars += part.image_url.length;
      }
    }
    // A tool call is part of the prompt too: its arguments are text the model has to read.
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      if (typeof call?.function?.name === 'string') chars += call.function.name.length;
      if (typeof call?.function?.arguments === 'string') chars += call.function.arguments.length;
    }
  }
  return { chars, tokens: Math.ceil(chars / PROMPT_CHARS_PER_TOKEN) };
}
