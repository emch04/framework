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
  confirmTool,
  masker,
  reportToolErrors = false,
  toolTimeoutMs,
  maxMs,
  finalInstruction,
  now = Date.now
}) {
  if (!registry) throw new AppError('agentLoop requires a registry', 500);
  if (!router || typeof router.ask !== 'function') throw new AppError('agentLoop requires a router', 500);
  if (masker && (typeof masker.mask !== 'function' || typeof masker.unmask !== 'function')) {
    throw new AppError('agentLoop requires masker from createReversibleMasker()', 500);
  }

  const messages = Array.isArray(history) ? [...history] : [];
  messages.push({ role: 'user', content: prompt });
  const started = now();

  /* The question is read by the entity detector once, so every name in it is
     known before the first byte leaves; afterwards the prompt is masked with
     what the masker has learnt. Inside the loop everything stays in clear —
     masking happens at the door, on the way out. */
  if (masker && typeof masker.maskAsync === 'function') await masker.maskAsync(String(prompt || ''));

  async function askModel(modelPrompt) {
    const outbound = masker ? masker.mask(modelPrompt) : modelPrompt;
    const raw = await router.ask(outbound, {
      complexity: 'agent',
      intent: 'agent_loop',
      estimatedTokens: estimateTokens(outbound)
    }, ctx);
    const readable = masker ? unmaskAnswer(masker, raw) : raw;
    // onChunk, when provided, is called with each chunk AS IT ARRIVES if
    // router.ask() returns a stream — real token-by-token streaming to the
    // caller. The loop itself still needs the fully-assembled text to
    // detect a <tool_call>, so it accumulates in parallel regardless.
    return stringifyModelResponse(readable, onChunk);
  }

  const outOfTime = () => Number.isFinite(maxMs) && now() - started >= maxMs;

  for (let step = 0; step < maxSteps && !outOfTime(); step += 1) {
    const response = await askModel(buildPrompt(registry, userRole, messages));
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

    /* A tool that reaches OUTSIDE (a web search, a third-party API) gets its
       parameters masked: the model wrote them from a masked prompt, the loop
       read them in clear, and they must not leave in clear. */
    const params = masker && tool.external === true ? masker.maskDeep(toolCall.params) : toolCall.params;
    let result;
    try {
      result = await runTool(tool, params, ctx, toolTimeoutMs);
    } catch (error) {
      if (!reportToolErrors) throw error;
      /* The model reads a code, never the error message: it may quote
         internals, and it is not the model's business. */
      result = { error: error && error.code === 'TOOL_TIMEOUT' ? 'tool_timeout' : 'tool_failed' };
    }
    if (masker && tool.external === true) result = masker.unmaskDeep(result);
    const serialized = JSON.stringify(result);
    /* Your own data (a class list, a file) carries names the register may not
       know: the detector reads the result before it can reach the prompt. */
    if (masker && tool.external !== true && typeof masker.maskAsync === 'function') await masker.maskAsync(String(serialized));
    messages.push({ role: 'assistant', content: response });
    messages.push({
      role: 'tool',
      content: `<tool_result name="${tool.name}">${serialized}</tool_result>`
    });
  }

  /* Out of steps or time: one last turn without tools, when the caller says
     how to ask for it — an answer with what was read beats an error. */
  if (typeof finalInstruction === 'string' && finalInstruction.trim()) {
    const last = await askModel(`${buildPrompt(null, userRole, messages)}\n\n${finalInstruction}`);
    const stray = parseToolCallSafely(last);
    return stray ? last.replace(TOOL_CALL_PATTERN, '').trim() : last;
  }

  throw new AppError(`agentLoop reached maxSteps (${maxSteps}) before a final answer`, 500);
}

async function runTool(tool, params, ctx, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return tool.handler(params, ctx);
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`Tool "${tool.name}" timed out`), { code: 'TOOL_TIMEOUT' })), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => tool.handler(params, ctx)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function unmaskAnswer(masker, raw) {
  if (isAsyncIterable(raw) && typeof masker.unmaskStream === 'function') return masker.unmaskStream(raw);
  return typeof raw === 'string' ? masker.unmask(raw) : raw;
}

function parseToolCallSafely(text) {
  try {
    return parseToolCall(text);
  } catch (_error) {
    return { name: 'invalid', params: {} };
  }
}

function buildPrompt(registry, userRole, messages) {
  const tools = registry ? registry.formatToolsForPrompt(userRole) : '';
  const renderedHistory = messages.map(message => {
    if (typeof message === 'string') return message;
    return `${message.role || 'message'}: ${message.content || ''}`;
  }).join('\n');

  return [
    tools ? `Available tools:\n${tools}` : 'Available tools:\n(none)',
    renderedHistory
  ].filter(Boolean).join('\n\n');
}

const TOOL_CALL_PATTERN = /<tool_call\s+name="([^"]+)">\s*([\s\S]*?)\s*<\/tool_call>/gi;

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
