const { AppError } = require('@astratra/core');

const DEFAULT_MAX_STEPS = 5;

async function runAgentLoop({
  prompt,
  ctx = {},
  history = [],
  registry,
  router,
  userRole,
  maxSteps = DEFAULT_MAX_STEPS,
  onChunk,
  confirmTool
}) {
  if (!registry) throw new AppError('agentLoop requires a registry', 500);
  if (!router || typeof router.ask !== 'function') throw new AppError('agentLoop requires a router', 500);

  const messages = Array.isArray(history) ? [...history] : [];
  messages.push({ role: 'user', content: prompt });

  for (let step = 0; step < maxSteps; step += 1) {
    const modelPrompt = buildPrompt(registry, userRole, messages);
    // onChunk, when provided, is called with each chunk AS IT ARRIVES if
    // router.ask() returns a stream — real token-by-token streaming to the
    // caller. The loop itself still needs the fully-assembled text to
    // detect a <tool_call>, so it accumulates in parallel regardless.
    const response = await stringifyModelResponse(await router.ask(modelPrompt, {
      complexity: 'agent',
      intent: 'agent_loop',
      estimatedTokens: estimateTokens(modelPrompt)
    }, ctx), onChunk);
    const toolCall = parseToolCall(response);

    if (!toolCall) {
      return response;
    }

    const tool = registry.getToolByName(toolCall.name);
    if (!tool) {
      throw new AppError(`Tool "${toolCall.name}" is not registered`, 400);
    }
    if (!tool.roles.includes(userRole)) {
      throw new AppError(`Tool "${toolCall.name}" is not allowed for role "${userRole}"`, 403);
    }

    // confirmTool, when provided, gates execution — e.g. a human approval
    // step surfaced by the calling app before a write/delete tool actually
    // runs. Denying doesn't crash the loop: the model gets told and can
    // adjust course (ask something else, explain, stop), same as it would
    // handle any other tool result.
    if (typeof confirmTool === 'function') {
      const approved = await confirmTool(toolCall, ctx);
      if (!approved) {
        messages.push({ role: 'assistant', content: response });
        messages.push({
          role: 'tool',
          content: `<tool_result name="${tool.name}">${JSON.stringify({ denied: true, reason: 'Execution was not approved.' })}</tool_result>`
        });
        continue;
      }
    }

    const result = await tool.handler(toolCall.params, ctx);
    messages.push({ role: 'assistant', content: response });
    messages.push({
      role: 'tool',
      content: `<tool_result name="${tool.name}">${JSON.stringify(result)}</tool_result>`
    });
  }

  throw new AppError(`agentLoop reached maxSteps (${maxSteps}) before a final answer`, 500);
}

function buildPrompt(registry, userRole, messages) {
  const tools = registry.formatToolsForPrompt(userRole);
  const renderedHistory = messages.map(message => {
    if (typeof message === 'string') return message;
    return `${message.role || 'message'}: ${message.content || ''}`;
  }).join('\n');

  return [
    tools ? `Available tools:\n${tools}` : 'Available tools:\n(none)',
    renderedHistory
  ].filter(Boolean).join('\n\n');
}

function parseToolCall(text) {
  const match = String(text || '').match(/<tool_call\s+name="([^"]+)">\s*([\s\S]*?)\s*<\/tool_call>/i);
  if (!match) return null;

  try {
    return {
      name: match[1],
      params: match[2] ? JSON.parse(match[2]) : {}
    };
  } catch (error) {
    throw new AppError(`Invalid JSON params for tool "${match[1]}": ${error.message}`, 400);
  }
}

async function stringifyModelResponse(value, onChunk) {
  if (isAsyncIterable(value)) {
    let output = '';
    for await (const chunk of value) {
      const text = String(chunk);
      output += text;
      if (typeof onChunk === 'function') onChunk(text);
    }
    return output;
  }
  const text = String(value ?? '');
  if (typeof onChunk === 'function') onChunk(text);
  return text;
}

function isAsyncIterable(value) {
  return value && typeof value[Symbol.asyncIterator] === 'function';
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

module.exports = {
  runAgentLoop
};
