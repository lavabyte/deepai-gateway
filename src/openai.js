/**
 * Conversion between the gateway's OpenAI surface and DeepAI upstream.
 *
 * The gateway speaks OpenAI to its clients and to most DeepAI models, so the
 * chat-completions path is a near pass-through. Only the Responses transport
 * needs reshaping, which is what this module does.
 *
 * @module deepai-gateway/openai
 */

/** Join the text of one OpenAI message content value. */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text' && typeof part.text === 'string') return part.text;
      if (part?.type === 'input_text' && typeof part.text === 'string') return part.text;
      return '';
    })
    .join('');
}

/**
 * Convert OpenAI chat messages into Responses API input items. Reasoning blocks
 * are dropped: the upstream regenerates them and they carry no replay value
 * here.
 *
 * @param {Array<object>} messages
 * @returns {Array<object>}
 */
export function openAIToResponsesInput(messages) {
  const input = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message === null || typeof message !== 'object') continue;

    if (message.role === 'system' || message.role === 'developer') {
      const text = contentText(message.content);
      if (text !== '') input.push({ role: 'system', content: [{ type: 'input_text', text }] });
      continue;
    }

    if (message.role === 'user') {
      const text = contentText(message.content);
      if (text !== '') input.push({ role: 'user', content: [{ type: 'input_text', text }] });
      continue;
    }

    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: String(message.tool_call_id ?? ''),
        output: contentText(message.content),
      });
      continue;
    }

    if (message.role === 'assistant') {
      const text = contentText(message.content);
      if (text !== '') {
        input.push({
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text }],
        });
      }
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        if (call === null || typeof call !== 'object') continue;
        input.push({
          type: 'function_call',
          call_id: String(call.id ?? ''),
          name: String(call.function?.name ?? ''),
          arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : '{}',
        });
      }
    }
  }
  return input;
}

/** Convert OpenAI tool wrappers into flattened Responses tools. */
export function openAIToResponsesTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool) => tool !== null && typeof tool === 'object' && tool?.function?.name)
    .map((tool) => ({
      type: 'function',
      name: tool.function.name,
      description: String(tool.function.description ?? ''),
      parameters:
        tool.function.parameters !== null && typeof tool.function.parameters === 'object'
          ? tool.function.parameters
          : { type: 'object', properties: {} },
    }));
}

/** Normalize an OpenAI `stop` value (string or array) into an array. */
export function stopSequences(stop) {
  if (typeof stop === 'string' && stop !== '') return [stop];
  if (Array.isArray(stop)) return stop.filter((item) => typeof item === 'string' && item !== '').slice(0, 4);
  return [];
}

/** Map a gateway reasoning effort onto the DeepAI wire value. */
export function effortOf(value) {
  switch (value) {
    case 'none':
    case 'off':
      return 'none';
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
    case 'max':
      return 'high';
    default:
      return undefined;
  }
}

/** Build one OpenAI streaming chunk. */
export function chunk({ id, model, created, delta, finishReason = null }) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** Build a complete (non-streamed) OpenAI response. */
export function completion({ id, model, created, message, finishReason, usage }) {
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage,
  };
}

/** Map the shared finish vocabulary onto OpenAI's. */
export function openAIFinish(reason) {
  switch (reason) {
    case 'tool_calls':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

/** Usage in OpenAI's shape, with cache and reasoning detail preserved. */
export function openAIUsage(tokens) {
  if (tokens === undefined) return undefined;
  const cacheRead = tokens.cacheReadTokens ?? 0;
  const cacheWrite = tokens.cacheWriteTokens ?? 0;
  const prompt = tokens.inputTokens + cacheRead + cacheWrite;
  return {
    prompt_tokens: prompt,
    completion_tokens: tokens.outputTokens,
    total_tokens: tokens.totalTokens ?? prompt + tokens.outputTokens,
    ...(cacheRead > 0 || cacheWrite > 0
      ? {
          prompt_tokens_details: {
            cached_tokens: cacheRead,
            ...(cacheWrite > 0 ? { cache_write_tokens: cacheWrite } : {}),
          },
        }
      : {}),
    ...(tokens.reasoningTokens > 0
      ? { completion_tokens_details: { reasoning_tokens: tokens.reasoningTokens } }
      : {}),
  };
}
