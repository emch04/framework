const { AppError } = require('@astratra/core');

const DEFAULT_MAX_STEPS = 5;
const DEFAULT_LOOP_THRESHOLDS = Object.freeze({ reminder: 3, firmReminder: 5, stop: 8 });
const DEFAULT_SPILL_THRESHOLD = 12_000;
const SPILL_TOOL_NAME = 'read_spilled_result';

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
  loopGuard = {},
  spill = {},
  confirmationPolicy,
  riskAnalyzers = [],
  pendingActions,
  onEvent,
  now = Date.now
}) {
  if (!registry) throw new AppError('agentLoop requires a registry', 500);
  if (!router || typeof router.ask !== 'function') throw new AppError('agentLoop requires a router', 500);
  if (masker && (typeof masker.mask !== 'function' || typeof masker.unmask !== 'function')) {
    throw new AppError('agentLoop requires masker from createReversibleMasker()', 500);
  }

  const messages = Array.isArray(history) ? [...history] : [];
  const loopCounts = new Map();
  const spillStore = spill.store || createMemorySpillStore();
  const spillThreshold = Number.isFinite(spill.threshold) && spill.threshold >= 0 ? spill.threshold : DEFAULT_SPILL_THRESHOLD;
  const thresholds = { ...DEFAULT_LOOP_THRESHOLDS, ...loopGuard };
  const spills = new Map();
  if (typeof spillStore.set !== 'function' || typeof spillStore.get !== 'function') throw new AppError('spill.store requires set() and get()', 500);
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
    const spillInstruction = spills.size ? `\n### Lire un résultat mis de côté\nAppelle <tool_call name="${SPILL_TOOL_NAME}">{"id":"référence","start":0,"length":4000}</tool_call> pour relire une tranche.` : '';
    const response = await askModel(buildPrompt(registry, userRole, messages) + spillInstruction);
    const toolCall = parseToolCall(response);

    if (!toolCall) {
      return response;
    }

    if (toolCall.name === SPILL_TOOL_NAME) {
      const id = String(toolCall.params.id || '');
      const stored = spills.get(id);
      let result;
      if (!stored) result = { error: 'spill_not_found' };
      else {
        const start = Math.max(0, Math.floor(Number(toolCall.params.start) || 0));
        const length = Math.min(12_000, Math.max(0, Math.floor(Number(toolCall.params.length) || 4000)));
        const value = await spillStore.get(id);
        result = typeof value === 'string' ? { id, start, totalLength: value.length, text: value.slice(start, start + length) } : { error: 'spill_not_found' };
      }
      messages.push({ role: 'assistant', content: response }, { role: 'tool', content: `<tool_result name="${SPILL_TOOL_NAME}">${JSON.stringify(result)}</tool_result>` });
      continue;
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
    const normalizedCall = `${tool.name}:${stableStringify(toolCall.params)}`;
    const repetitions = (loopCounts.get(normalizedCall) || 0) + 1;
    loopCounts.set(normalizedCall, repetitions);
    if (repetitions >= thresholds.stop) {
      const reason = `Boucle arrêtée : l'appel ${tool.name} a été répété ${repetitions} fois.`;
      const event = { type: 'tool_loop_stopped', name: tool.name, repetitions, reason };
      if (typeof onEvent === 'function') onEvent(event);
      return reason;
    }
    if (repetitions === thresholds.reminder || repetitions === thresholds.firmReminder) {
      const reminder = repetitions === thresholds.reminder
        ? `Rappel : cet appel identique a déjà été effectué ${repetitions} fois. Change de stratégie si le résultat ne suffit pas.`
        : `Rappel ferme : cet appel identique a déjà été effectué ${repetitions} fois. Ne le répète plus sans modifier les arguments.`;
      messages.push({ role: 'system', content: reminder });
      if (typeof onEvent === 'function') onEvent({ type: 'tool_loop_warning', name: tool.name, repetitions, message: reminder });
    }

    let requiresConfirmation = typeof confirmTool === 'function';
    if (confirmationPolicy !== undefined) {
      let risk = tool.risk || 'UNKNOWN';
      for (const analyze of riskAnalyzers) {
        const analyzed = await analyze(toolCall, ctx, tool);
        if (analyzed !== undefined && riskValue(analyzed) > riskValue(risk)) risk = String(analyzed).toUpperCase();
      }
      requiresConfirmation = shouldConfirm(confirmationPolicy, risk);
    }
    if (requiresConfirmation) {
      let approved;
      if (typeof confirmTool === 'function') approved = await confirmTool(toolCall, ctx);
      else if (pendingActions && typeof pendingActions.propose === 'function') {
        const proposed = await pendingActions.propose({ action: tool.name, payload: toolCall.params, description: `Appel ${tool.name} (${tool.risk || 'UNKNOWN'})`, proposedBy: ctx.userId, tenant: ctx.tenantId });
        approved = false;
        messages.push({ role: 'assistant', content: response }, { role: 'tool', content: `<tool_result name="${tool.name}">${JSON.stringify({ pending: true, actionId: proposed.action.id })}</tool_result>` });
        continue;
      } else approved = false;
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
    const modelSerialized = masker ? masker.mask(serialized) : serialized;
    /* Your own data (a class list, a file) carries names the register may not
       know: the detector reads the result before it can reach the prompt. */
    if (masker && tool.external !== true && typeof masker.maskAsync === 'function') await masker.maskAsync(String(serialized));
    messages.push({ role: 'assistant', content: response });
    let modelResult = serialized;
    if (serialized.length > spillThreshold) {
      const id = createSpillId();
      try {
        await spillStore.set(id, serialized);
        spills.set(id, true);
        modelResult = JSON.stringify({ spilled: true, id, totalLength: serialized.length, excerpt: modelSerialized.slice(0, 1500), readTool: SPILL_TOOL_NAME });
      } catch (_error) {
        modelResult = JSON.stringify({ error: 'result_storage_failed' });
      }
    }
    messages.push({
      role: 'tool',
      content: `<tool_result name="${tool.name}">${modelResult}</tool_result>`
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

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
function riskValue(risk) { return ({ LOW: 0, MEDIUM: 1, HIGH: 2, UNKNOWN: 3 })[String(risk).toUpperCase()] ?? 3; }
function shouldConfirm(policy, risk) {
  if (policy === 'always') return true;
  if (policy === 'never') return false;
  const threshold = typeof policy === 'object' && policy ? policy.threshold : policy;
  return risk === 'UNKNOWN' || riskValue(risk) >= riskValue(threshold);
}
function createMemorySpillStore() {
  const values = new Map();
  return { async set(id, value) { values.set(id, value); }, async get(id) { return values.get(id); } };
}
function createSpillId() { return `spill_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`; }

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
  runAgentLoop,
  createMemorySpillStore,
  DEFAULT_LOOP_THRESHOLDS,
  DEFAULT_SPILL_THRESHOLD
};
